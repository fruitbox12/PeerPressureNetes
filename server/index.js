// server/index.js
/**
 * Decentralized Orchestrator Node
 * 
 * Responsibilities:
 * - Initialize secure networking with Hyperswarm.
 * - Join common swarm topic derived from SWARM_NAME.
 * - Setup Hyperbee for shared state replication (Autobee multi-writer CRDT style).
 * - Implement simplified PBFT consensus for task assignment.
 * - Perform decentralized scheduling: propose, agree, and decide on task assignments.
 * - Launch worker processes to execute tasks in Docker containers.
 */

const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const net = require('net');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

// Hyperbee and storage
const Hyperbee = require('hyperbee');
const RAM = require('random-access-memory'); // For demo; replace with persistent storage in production

const { v4: uuidv4 } = require('uuid');

// Load environment variables
const NODE_ID = process.env.NODE_ID || crypto.randomBytes(4).toString('hex');
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const WS_PORT = process.env.WS_PORT || 8585;
const SWARM_NAME = process.env.SWARM_NAME || 'default-swarm';
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '..', 'data', NODE_ID);

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_PATH)) {
  fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

// Generate or load Ed25519 key pair for this node
let keyPair;
try {
  const keyFile = path.join(STORAGE_PATH, 'keypair.json');
  if (fs.existsSync(keyFile)) {
    keyPair = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    keyPair = {
      public: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
      private: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex')
    };
    fs.writeFileSync(keyFile, JSON.stringify(keyPair), 'utf8');
  }
} catch (err) {
  console.error("Key generation failed:", err);
  process.exit(1);
}

console.log(`[${NODE_ID}] Starting node with HTTP_PORT=${HTTP_PORT}, WS_PORT=${WS_PORT}`);

// Derive common swarm topic from SWARM_NAME (using SHA256)
const swarmTopic = crypto.createHash('sha256').update(SWARM_NAME).digest();

// Initialize Hyperswarm with this node’s key pair
const swarm = new Hyperswarm({
  keyPair: {
    publicKey: Buffer.from(keyPair.public, 'hex'),
    secretKey: Buffer.from(keyPair.private, 'hex')
  }
  // Optionally, add a firewall to allow only pre-approved nodes.
});

// Setup Hyperbee over RAM storage (for demo; use persistent storage in production)
const feed = new RAM(STORAGE_PATH + '/hypercore');
const db = new Hyperbee(feed, { keyEncoding: 'utf-8', valueEncoding: 'json' });

// In-memory map to track connected peers and metadata
const peers = new Map();

// PBFT state (simplified)
const pbftState = {
  // Map from opId to { op, prepares: Set(), commits: Set() }
  operations: new Map()
};

// Utility: Sign a message using our private key
function signMessage(message) {
  const sign = crypto.createSign('sha256');
  const msgString = JSON.stringify(message);
  sign.update(msgString);
  sign.end();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(keyPair.private, 'hex'),
    format: 'der',
    type: 'pkcs8'
  });
  return sign.sign(privateKey).toString('hex');
}

// Utility: Verify a message signature with a given public key
function verifyMessage(message, signature, publicKeyHex) {
  const verify = crypto.createVerify('sha256');
  const msgString = JSON.stringify(message);
  verify.update(msgString);
  verify.end();
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyHex, 'hex'),
    format: 'der',
    type: 'spki'
  });
  return verify.verify(publicKey, Buffer.from(signature, 'hex'));
}

// Broadcast a message to all connected peers
function broadcast(message) {
  const data = Buffer.from(JSON.stringify(message));
  for (const [peerId, peerInfo] of peers.entries()) {
    if (peerInfo.socket && !peerInfo.socket.destroyed) {
      peerInfo.socket.write(data);
    }
  }
}

// Handle incoming messages over a peer connection
function handleMessage(data, remoteKey) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch (err) {
    console.error(`[${NODE_ID}] Failed to parse message:`, err);
    return;
  }
  // Check for required fields
  if (!message.signature || !message.sender) {
    console.warn(`[${NODE_ID}] Received unsigned message`);
    return;
  }
  // Verify the signature
  if (!verifyMessage(message.payload, message.signature, message.sender)) {
    console.warn(`[${NODE_ID}] Invalid signature from ${message.sender}`);
    return;
  }
  // Process message based on type
  switch (message.payload.type) {
    case 'HANDSHAKE':
      console.log(`[${NODE_ID}] Handshake received from ${message.payload.nodeId}`);
      peers.set(message.payload.nodeId, { socket: null, lastSeen: Date.now(), key: message.sender });
      break;
    case 'PBFT_PROPOSE':
      processPbftProposal(message.payload);
      break;
    case 'PBFT_PREPARE':
      processPbftPrepare(message.payload);
      break;
    case 'PBFT_COMMIT':
      processPbftCommit(message.payload);
      break;
    case 'HEARTBEAT':
      if (peers.has(message.payload.nodeId)) {
        peers.get(message.payload.nodeId).lastSeen = Date.now();
      }
      break;
    default:
      console.log(`[${NODE_ID}] Unknown message type: ${message.payload.type}`);
  }
}

// Send a message over a socket
function sendMessage(socket, payload) {
  const message = {
    sender: keyPair.public,
    payload
  };
  message.signature = signMessage(payload);
  socket.write(JSON.stringify(message));
}

// Handle new Hyperswarm connections
swarm.on('connection', (socket, info) => {
  const remoteKey = info.remotePublicKey.toString('hex');
  console.log(`[${NODE_ID}] Connected to peer with key: ${remoteKey}`);
  socket.on('data', (data) => {
    handleMessage(data, remoteKey);
  });
  socket.on('error', (err) => {
    console.error(`[${NODE_ID}] Socket error with peer ${remoteKey}:`, err);
  });
  socket.on('close', () => {
    console.log(`[${NODE_ID}] Connection closed with peer ${remoteKey}`);
  });
  // Immediately send handshake message
  const handshakePayload = {
    type: 'HANDSHAKE',
    nodeId: NODE_ID,
    timestamp: Date.now()
  };
  sendMessage(socket, handshakePayload);
});

// Join the swarm using the common topic
swarm.join(swarmTopic, { server: true, client: true });
swarm.flush().then(() => {
  console.log(`[${NODE_ID}] Joined swarm on topic: ${swarmTopic.toString('hex')}`);
});

// Periodic heartbeat broadcast to peers
setInterval(() => {
  const heartbeatPayload = {
    type: 'HEARTBEAT',
    nodeId: NODE_ID,
    timestamp: Date.now()
  };
  broadcast({ payload: heartbeatPayload, sender: keyPair.public, signature: signMessage(heartbeatPayload) });
}, 5000);

// --- PBFT Consensus Implementation (Simplified) ---
function proposeOperation(op) {
  // op: { opId, type, details }
  op.proposer = NODE_ID;
  op.timestamp = Date.now();
  op.signature = signMessage(op);
  const payload = {
    type: 'PBFT_PROPOSE',
    op: op
  };
  broadcast({ payload, sender: keyPair.public, signature: signMessage(payload) });
  pbftState.operations.set(op.opId, { op, prepares: new Set([NODE_ID]), commits: new Set() });
  // Immediately prepare our own proposal
  processPbftPrepare({ opId: op.opId, nodeId: NODE_ID });
}

function processPbftProposal(proposal) {
  if (!proposal.op || !proposal.op.opId) {
    console.warn(`[${NODE_ID}] Invalid proposal received`);
    return;
  }
  // Immediately send prepare response for the proposal
  const preparePayload = {
    type: 'PBFT_PREPARE',
    opId: proposal.op.opId,
    nodeId: NODE_ID,
    timestamp: Date.now()
  };
  broadcast({ payload: preparePayload, sender: keyPair.public, signature: signMessage(preparePayload) });
  if (!pbftState.operations.has(proposal.op.opId)) {
    pbftState.operations.set(proposal.op.opId, { op: proposal.op, prepares: new Set(), commits: new Set() });
  }
  pbftState.operations.get(proposal.op.opId).prepares.add(NODE_ID);
  if (pbftState.operations.get(proposal.op.opId).prepares.size >= 2) {
    const commitPayload = {
      type: 'PBFT_COMMIT',
      opId: proposal.op.opId,
      nodeId: NODE_ID,
      timestamp: Date.now()
    };
    broadcast({ payload: commitPayload, sender: keyPair.public, signature: signMessage(commitPayload) });
    pbftState.operations.get(proposal.op.opId).commits.add(NODE_ID);
    if (pbftState.operations.get(proposal.op.opId).commits.size >= 2) {
      decideOperation(proposal.op);
    }
  }
}

function processPbftPrepare(prep) {
  if (!pbftState.operations.has(prep.opId)) {
    pbftState.operations.set(prep.opId, { op: null, prepares: new Set(), commits: new Set() });
  }
  pbftState.operations.get(prep.opId).prepares.add(prep.nodeId);
}

function processPbftCommit(commit) {
  if (!pbftState.operations.has(commit.opId)) {
    pbftState.operations.set(commit.opId, { op: null, prepares: new Set(), commits: new Set() });
  }
  pbftState.operations.get(commit.opId).commits.add(commit.nodeId);
  if (pbftState.operations.get(commit.opId).commits.size >= 2 && pbftState.operations.get(commit.opId).op) {
    decideOperation(pbftState.operations.get(commit.opId).op);
  }
}

function decideOperation(op) {
  console.log(`[${NODE_ID}] Decided on operation: ${JSON.stringify(op)}`);
  if (op.type === 'ASSIGN_TASK') {
    // op.details: { taskId, image, cmd, assignedNode }
    const taskKey = `tasks/${op.details.taskId}`;
    db.put(taskKey, {
      status: 'assigned',
      assignedNode: op.details.assignedNode,
      image: op.details.image,
      cmd: op.details.cmd,
      timestamp: Date.now()
    }).then(() => {
      console.log(`[${NODE_ID}] Updated task state in Hyperbee for task ${op.details.taskId}`);
      if (op.details.assignedNode === NODE_ID) {
        launchWorkerForTask(op.details);
      }
    }).catch(err => {
      console.error(`[${NODE_ID}] Failed to update Hyperbee for task ${op.details.taskId}:`, err);
    });
  }
}

// --- Decentralized Scheduling ---
// For demonstration, simulate task submissions periodically.
setInterval(() => {
  if (Math.random() < 0.5) { // 50% chance to propose a new task
    const taskId = uuidv4();
    const assignedNode = NODE_ID; // For demo, assign to self. In production, choose based on load.
    const op = {
      opId: uuidv4(),
      type: 'ASSIGN_TASK',
      details: {
        taskId,
        image: "node:14-alpine",
        cmd: ["node", "-e", `console.log("Hello from task ${taskId} on ${NODE_ID}")`],
        assignedNode
      }
    };
    console.log(`[${NODE_ID}] Proposing task ${taskId} assigned to ${assignedNode}`);
    proposeOperation(op);
  }
}, 15000); // Every 15 seconds

// --- Launch Worker Process ---
function launchWorkerForTask(taskDetails) {
  console.log(`[${NODE_ID}] Launching worker for task ${taskDetails.taskId}`);
  const workerPath = path.join(__dirname, '..', 'worker', 'worker.js');
  const taskPayload = JSON.stringify(taskDetails);
  const worker = fork(workerPath, [taskPayload], { env: { NODE_ID } });
  worker.on('exit', (code) => {
    console.log(`[${NODE_ID}] Worker for task ${taskDetails.taskId} exited with code ${code}`);
    const taskKey = `tasks/${taskDetails.taskId}`;
    db.put(taskKey, {
      status: code === 0 ? 'completed' : 'failed',
      completedAt: Date.now()
    }).then(() => {
      console.log(`[${NODE_ID}] Task ${taskDetails.taskId} state updated to ${code === 0 ? 'completed' : 'failed'}`);
    }).catch(err => {
      console.error(`[${NODE_ID}] Failed to update state for task ${taskDetails.taskId}:`, err);
    });
  });
}

// --- Failure Detection & Cleanup ---
setInterval(() => {
  const now = Date.now();
  for (const [peerId, peerInfo] of peers.entries()) {
    if (now - peerInfo.lastSeen > 15000) {
      console.warn(`[${NODE_ID}] Peer ${peerId} unresponsive. Initiate failure protocol (not fully implemented).`);
      // Here you would propose a "FAIL_NODE" operation via PBFT and reassign tasks.
    }
  }
}, 10000);

// --- Graceful Shutdown ---
function shutdown() {
  console.log(`[${NODE_ID}] Shutting down node...`);
  swarm.destroy(() => {
    console.log(`[${NODE_ID}] Swarm destroyed.`);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
