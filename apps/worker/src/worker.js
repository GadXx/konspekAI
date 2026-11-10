import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDatabase, claimNextJob, getExpiredJobs, getReferencedMediaPaths, recoverExpiredLeases, updateJob } from '../../../packages/database/src/database.js';
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
  await mkdir(config.uploadDirectory, { recursive: true });
  const failedWithMedia = await getDatabase().selectFrom('jobs').select(['id', 'source_path'])
    .where('status', '=', 'failed').where('source_path', 'is not', null).execute();
  for (const job of failedWithMedia) {
    if (isPathInUploadDirectory(job.source_path)) {
      await rm(job.source_path, { force: true });
    }
    await updateJob(job.id, { source_path: null });
  }
  const expired = await getExpiredJobs();
  for (const job of expired) {
    if (job.source_path && isPathInUploadDirectory(job.source_path)) {
      await rm(job.source_path, { force: true });
    }
  }
  if (expired.length > 0) {
    const expirationCutoff = new Date().toISOString();
    await getDatabase().deleteFrom('jobs')
      .where('expires_at', '<=', expirationCutoff)
      .where((expression) => expression.or([
        expression('status', '!=', 'processing'),
        expression('lease_expires_at', '<=', expirationCutoff),
      ]))
      .execute();
  }
  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Removed expired jobs');
  }
  const uploadDirectory = resolve(config.uploadDirectory);
  const referenced = new Set((await getReferencedMediaPaths()).map((path) => resolve(path)));
  const orphanCutoff = Date.now() - config.orphanUploadRetentionHours * 3600000;
  for (const entry of await readdir(uploadDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {continue;}
    const path = resolve(uploadDirectory, entry.name);
    if (referenced.has(path)) {continue;}
    try {
      const details = await stat(path);
      if (details.mtimeMs <= orphanCutoff) {await rm(path, { force: true });}
    } catch (error) {
      if (error.code !== 'ENOENT') {throw error;}
    }
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
  await cleanupExpired();
  await Promise.all(Array.from({ length: config.workerConcurrency }, () => pollWorker()));
} catch (error) {
  logger.error({ error }, 'Worker stopped unexpectedly');
  process.exitCode = 1;
} finally {
  clearInterval(cleanupTimer);
  disposeModels();
  await getDatabase().destroy();
}
