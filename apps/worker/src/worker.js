import { rm } from 'node:fs/promises';
import { getDatabase, claimNextJob, getExpiredJobs, migrate, recoverExpiredLeases } from '../../../packages/database/src/database.js';
import { config } from '../../../packages/config/src/config.js';
import { disposeModels } from '../../../packages/media/src/transcribe.js';
import { isPathInUploadDirectory } from '../../../packages/media/src/path.js';
import { processJob } from './processor.js';

const logger = {
  info: (details, message) => console.info(JSON.stringify({ level: 'info', message, ...details })),
  error: (details, message) => console.error(JSON.stringify({ level: 'error', message, ...details, error: details?.error?.message })),
};

let stopping = false;

async function pollWorker() {
  await migrate();
  const recovered = await recoverExpiredLeases();
  logger.info({ recovered }, 'Recovered expired job leases');
  let lastLeaseSweep = Date.now();
  while (!stopping) {
    if (Date.now() - lastLeaseSweep >= 30000) {
      const recoveredDuringRun = await recoverExpiredLeases();
      if (recoveredDuringRun > 0) {
        logger.info({ recovered: recoveredDuringRun }, 'Recovered expired job leases');
      }
      lastLeaseSweep = Date.now();
    }
    const job = await claimNextJob({ leaseSeconds: config.jobLeaseSeconds });
    if (job) {
      await processJob(job, logger);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function cleanupExpired() {
  const expired = await getExpiredJobs();
  for (const job of expired) {
    if (job.source_path && isPathInUploadDirectory(job.source_path)) {
      await rm(job.source_path, { force: true });
    }
  }
  if (expired.length > 0) {
    const expirationCutoff = new Date().toISOString();
    await getDatabase().deleteFrom('jobs').where('expires_at', '<=', expirationCutoff).execute();
  }
  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Removed expired jobs');
  }
}

const cleanupTimer = setInterval(() => {
  cleanupExpired().catch((error) => logger.error({ error }, 'Job cleanup failed'));
}, 60000);
cleanupTimer.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; });
}

try {
  await Promise.all(Array.from({ length: config.workerConcurrency }, () => pollWorker()));
} catch (error) {
  logger.error({ error }, 'Worker stopped unexpectedly');
  process.exitCode = 1;
} finally {
  clearInterval(cleanupTimer);
  disposeModels();
  await getDatabase().destroy();
}
