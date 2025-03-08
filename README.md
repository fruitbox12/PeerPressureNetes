# Decentralized Container Orchestration System

This project implements a decentralized container orchestration system that uses:

- **Hyperswarm DHT** for peer-to-peer node discovery (all nodes join a common hash-based topic).
- **PBFT Consensus** for fault-tolerant agreement on state changes (task assignments and failure handling).
- **Hyperbee (Autobee CRDT)** for a leaderless, multi-writer shared state store. Autobase + Hyperbee
- **Dockerode** for executing tasks within isolated Docker containers.
- **Ed25519 Signatures (Keypear)** for secure, authenticated inter-node communication.

## Features

- **Decentralized Architecture:** No single master; every node is equal in scheduling and state replication.
- **Fault Tolerance:** PBFT consensus ensures correct decisions even if some nodes fail or act maliciously.
- **Automatic Task Assignment & Reassignment:** Tasks are scheduled via consensus and automatically reassigned if a node goes down.
- **Secure Communication:** All messages are digitally signed using Ed25519; Hyperswarm provides encrypted channels.
- **Shared State:** Cluster state is maintained in Hyperbee using a multi-writer CRDT approach.
- **Automated Cleanup:** Docker containers auto-remove upon exit, and the deploy script cleans up all processes.
- **Single Script Deployment:** `deploy.js` reads `cluster-config.yaml` and spins up all nodes.

## Repository Structure

. ├── deploy.js # Deployment script for launching nodes ├── cluster-config.yaml # Cluster configuration (swarm name, node count, ports, cleanup flag) ├── package.json # Dependencies and project metadata ├── README.md # This documentation file ├── server │ └── index.js # Orchestrator node: networking, consensus, scheduling, and state sync └── worker └── worker.js # Worker process that runs tasks in Docker containers

markdown

Edit

## Requirements

- Node.js (>=14)
- Docker (running locally and accessible via `/var/run/docker.sock`)
- NPM

## Setup and Deployment

1. **Clone the Repository:**
   ```bash
   git clone https://your-repo-url.git
   cd decentralized-container-orchestration
Install Dependencies:

bash

Edit
npm install
Configure the Cluster: Edit cluster-config.yaml if needed. The sample configuration:


```yaml
swarm: test-name
nodes:
  count: 10
  httpPort: 8080
  wsPort: 8585
  randomPortRange:
    min: 3000
    max: 10000
cleanup: true
Deploy the Cluster: Start the deployment script:
```

```bash
npm start
```
This spawns the specified number of node processes. Each node joins the common swarm, participates in consensus, and periodically simulates task assignments.
This project is licensed under the Apache-2.0 License.

---

### Final Notes

This codebase is detailed and “production‑inspired” but remains a prototype. In a production system you would:
- Use persistent storage for Hyperbee (e.g., using `random-access-file` instead of RAM).
- Secure key management (avoid storing private keys in plain text).
- Enhance the PBFT consensus implementation for a larger number of nodes and more rigorous fault tolerance.
- Extend failure detection, logging, and monitoring.
- Optionally expose HTTP or WebSocket endpoints for external APIs.

You can now deploy the entire system by running `npm install` and then `npm start` from the project root. Each node process will self-organize, accept simulated tasks, run them in Docker containers, and update shared state via Hyperbee—all while communicating securely over Hyperswarm.

Feel free to adjust, extend, or integrate further features as required.
