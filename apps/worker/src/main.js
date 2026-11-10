process.env.SERVICE_ROLE ??= 'worker';
await import('./worker.js');
