// worker/worker.js
/**
 * Worker process that executes a task inside a Docker container using Dockerode.
 * 
 * Expected task payload (as JSON via process.argv[2]):
 * {
 *   "taskId": "<uuid>",
 *   "image": "<docker image>",
 *   "cmd": ["command", "arg1", ...]
 * }
 */

const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const task = JSON.parse(process.argv[2]);
console.log(`[Worker] Executing task ${task.taskId}: Running image ${task.image} with command ${task.cmd.join(' ')}`);

docker.run(
  task.image,         // Docker image to run
  task.cmd,           // Command to execute inside container
  process.stdout,     // Stream container output to stdout
  { Tty: false, HostConfig: { AutoRemove: true } }, // Options: disable TTY and auto-remove container upon exit
  (err, data, container) => {
    if (err) {
      console.error(`[Worker] Task ${task.taskId} failed:`, err);
      process.exit(1);
    } else {
      console.log(`[Worker] Task ${task.taskId} completed with exit code ${data.StatusCode}`);
      process.exit(data.StatusCode === 0 ? 0 : 1);
    }
  }
);
