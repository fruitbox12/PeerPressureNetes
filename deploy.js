// deploy.js
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const net = require('net');

const configPath = path.join(__dirname, 'cluster-config.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const nodeCount = config.nodes.count || 1;
const baseHttpPort = config.nodes.httpPort || 8080;
const baseWsPort = config.nodes.wsPort || 8585;
const randomMin = config.nodes.randomPortRange.min || 3000;
const randomMax = config.nodes.randomPortRange.max || 10000;
const swarmName = config.swarm || "default-swarm";
const cleanupEnabled = config.cleanup === true;

const children = [];

async function getAvailablePort(preferredPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(null);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(preferredPort);
      });
    });
    server.listen(preferredPort);
  });
}

async function launchNode(index) {
  let httpPort = await getAvailablePort(baseHttpPort + index);
  let wsPort = await getAvailablePort(baseWsPort + index);
  if (!httpPort) httpPort = Math.floor(Math.random() * (randomMax - randomMin) + randomMin);
  if (!wsPort) wsPort = Math.floor(Math.random() * (randomMax - randomMin) + randomMin);

  console.log(`Launching node ${index} with HTTP_PORT=${httpPort} and WS_PORT=${wsPort}`);

  // Pass environment variables for the node (unique NODE_ID, ports, swarm name, and storage directory)
  const env = Object.assign({}, process.env, {
    NODE_ID: `node-${index}`,
    HTTP_PORT: httpPort,
    WS_PORT: wsPort,
    SWARM_NAME: swarmName,
    STORAGE_PATH: path.join(__dirname, 'data', `node-${index}`)
  });

  const child = fork(path.join(__dirname, 'server', 'index.js'), [], { env });
  child.on('exit', () => console.log(`Node ${index} exited`));
  children.push(child);
}

async function launchAllNodes() {
  for (let i = 0; i < nodeCount; i++) {
    await launchNode(i);
  }
}

function cleanup() {
  console.log('Cleaning up all nodes...');
  children.forEach(child => child.kill('SIGTERM'));
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

launchAllNodes();
