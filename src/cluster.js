import cluster from 'node:cluster';
import os from 'node:os';

const MAX_WORKERS = parseInt(process.env.CLUSTER_WORKERS, 10) || Math.min(os.availableParallelism?.() || os.cpus().length, 4);

if (cluster.isPrimary) {
  console.log(`[Cluster] primary ${process.pid} spawning ${MAX_WORKERS} workers`);

  for (let i = 0; i < MAX_WORKERS; i++) cluster.fork();

  cluster.on('exit', (worker, code) => {
    console.warn(`[Cluster] worker ${worker.process.pid} exited (code=${code}), restarting`);
    cluster.fork();
  });
} else {
  await import('./server.js');
}
