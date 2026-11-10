import { rm } from 'node:fs/promises';
import { getDatabase, getJob, updateJob } from '../../../packages/database/src/database.js';
import { config } from '../../../packages/config/src/config.js';
import { transcribeMedia } from '../../../packages/media/src/transcribe.js';
import { createSummary, normalizeTranscript } from '../../../packages/llm/src/pipeline.js';
import { isPathInUploadDirectory } from '../../../packages/media/src/path.js';

async function removeSource(sourcePath) {
  if (sourcePath && isPathInUploadDirectory(sourcePath)) {
    await rm(sourcePath, { force: true });
  }
}

export async function processJob(claimedJob, logger = console) {
  const database = getDatabase();
  let leaseBusy = false;
  const heartbeat = setInterval(async () => {
    if (leaseBusy) {
      return;
    }
    leaseBusy = true;
    try {
      await updateJob(claimedJob.id, { lease_expires_at: new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString() }, database);
    } catch (error) {
      logger.error?.({ jobId: claimedJob.id, error }, 'Failed to renew job lease');
    } finally {
      leaseBusy = false;
    }
  }, Math.max(5000, Math.floor(config.jobLeaseSeconds * 1000 / 3)));
  heartbeat.unref?.();
  let sourcePath = claimedJob.source_path;

  try {
    let current = await getJob(claimedJob.id, database);
    let recognizedText = current.recognized_text;
    if (!recognizedText) {
      if (current.input_kind === 'text') {
        recognizedText = current.input_text;
      } else {
        if (!current.source_path) {
          throw Object.assign(new Error('Uploaded media is missing'), { code: 'MEDIA_MISSING' });
        }
        await updateJob(current.id, { progress: 'transcribing' }, database);
        recognizedText = await transcribeMedia(current.source_path, current.language);
      }
      current = await updateJob(current.id, {
        recognized_text: recognizedText,
        source_path: null,
        progress: 'normalizing_transcript',
      }, database);
      if (sourcePath) {
        await removeSource(sourcePath);
        sourcePath = null;
      }
    } else if (current.source_path) {
      await updateJob(current.id, { source_path: null }, database);
      await removeSource(current.source_path);
      sourcePath = null;
    }

    await updateJob(claimedJob.id, { progress: 'normalizing_transcript' }, database);
    const normalizedTranscript = current?.normalized_transcript
      ?? await normalizeTranscript(recognizedText, claimedJob.language);
    await updateJob(claimedJob.id, { normalized_transcript: normalizedTranscript, progress: 'creating_summary' }, database);
    const note = await createSummary(normalizedTranscript, {
      summaryType: claimedJob.summary_type,
      summaryLanguage: claimedJob.summary_language,
    });
    await updateJob(claimedJob.id, {
      status: 'completed',
      progress: 'completed',
      note_json: JSON.stringify(note),
      error_code: null,
      error_message: null,
      lease_expires_at: null,
    }, database);
  } catch (error) {
    logger.error?.({ jobId: claimedJob.id, error }, 'Job processing failed');
    const current = await getJob(claimedJob.id, database);
    const isTerminal = current.attempt_count >= config.jobMaxAttempts;
    const retryDelay = config.jobRetryBaseMs * (2 ** Math.max(0, current.attempt_count - 1));
    await updateJob(claimedJob.id, {
      status: isTerminal ? 'failed' : 'queued',
      progress: isTerminal ? 'failed' : 'queued',
      next_attempt_at: new Date(Date.now() + retryDelay).toISOString(),
      lease_expires_at: null,
      error_code: error.code ?? 'PROCESSING_FAILED',
      error_message: String(error.message ?? 'Processing failed').slice(0, 1000),
    }, database);
    if (isTerminal) {
      await removeSource(sourcePath);
      await updateJob(claimedJob.id, { source_path: null }, database);
    }
  } finally {
    clearInterval(heartbeat);
  }
}
