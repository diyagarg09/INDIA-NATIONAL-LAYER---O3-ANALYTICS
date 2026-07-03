// WebWorkerPool.js
// Manages a pool of Web Workers to parse heavy grid data streams concurrently without freezing the UI.

class WebWorkerPool {
  constructor(workerScriptPath = '/worker.js', poolSize = 3) {
    this.workerScriptPath = workerScriptPath;
    this.poolSize = poolSize;
    this.workers = [];
    this.queue = [];
    this.activeWorkers = new Set();
    
    this.initPool();
  }

  initPool() {
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(this.workerScriptPath);
        worker.id = i;
        this.workers.push(worker);
      } catch (err) {
        console.error('Failed to initialize Web Worker in pool:', err);
      }
    }
  }

  // Executes a parsing task. Returns a Promise.
  runJob(data) {
    return new Promise((resolve, reject) => {
      // Find an idle worker
      const idleWorker = this.workers.find(w => !this.activeWorkers.has(w));

      if (idleWorker) {
        this.execute(idleWorker, data, resolve, reject);
      } else {
        // Queue the task
        this.queue.push({ data, resolve, reject });
      }
    });
  }

  execute(worker, data, resolve, reject) {
    this.activeWorkers.add(worker);

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      this.activeWorkers.delete(worker);
      
      // Process next item in the queue
      if (this.queue.length > 0) {
        const nextJob = this.queue.shift();
        this.execute(worker, nextJob.data, nextJob.resolve, nextJob.reject);
      }
    };

    worker.onmessage = (e) => {
      const { type, payload, error } = e.data;
      if (type === 'PARSE_SUCCESS') {
        resolve(payload);
      } else {
        reject(new Error(error || 'Worker execution failed'));
      }
      cleanup();
    };

    worker.onerror = (err) => {
      reject(err);
      cleanup();
    };

    // Send task to the worker
    worker.postMessage({
      type: 'PARSE_GRID_DATA',
      data
    });
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.queue = [];
    this.activeWorkers.clear();
  }
}

export default WebWorkerPool;
