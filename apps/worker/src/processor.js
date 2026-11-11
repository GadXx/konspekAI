import { rm } from 'node:fs/promises';
import { getDatabase, getJob, updateClaimedJob } from '../../../packages/database/src/database.js';
import { config } from '../../../packages/config/src/config.js';
import { transcribeMedia } from '../../../packages/media/src/transcribe.js';
import { createSummary, normalizeTranscript } from '../../../packages/llm/src/pipeline.js';
import { isPathInUploadDirectory } from '../../../packages/media/src/path.js';
import { isPlaceholderText } from '../../../packages/domain/src/job.js';

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
      await updateClaimedJob(claimedJob.id, claimedJob.lease_token, { lease_expires_at: new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString() }, database);
    } catch (error) {
      logger.error?.({ jobId: claimedJob.id, error }, 'Failed to renew job lease');
    } finally {
      leaseBusy = false;
    }
  }, Math.max(5000, Math.floor(config.jobLeaseSeconds * 1000 / 3)));
  heartbeat.unref?.();
  let sourcePath = claimedJob.source_path;
  const updateOwnedJob = async (fields) => {
    const updated = await updateClaimedJob(claimedJob.id, claimedJob.lease_token, fields, database);
    if (!updated) {
      const error = new Error('The job lease is no longer owned by this worker');
      error.code = 'JOB_LEASE_LOST';
      throw error;
    }
    return updated;
  };

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
        await updateOwnedJob({ progress: 'transcribing' });
        recognizedText = await transcribeMedia(current.source_path, current.language);
      }
      current = await updateOwnedJob({
        recognized_text: recognizedText,
        progress: 'normalizing_transcript',
      });
      if (sourcePath) {
        await removeSource(sourcePath);
        await updateOwnedJob({ source_path: null });
        sourcePath = null;
      }
    } else if (current.source_path) {
      await removeSource(current.source_path);
      await updateOwnedJob({ source_path: null });
      sourcePath = null;
    }

    if (isPlaceholderText(recognizedText)) {
      throw Object.assign(new Error('The input contains only placeholder text'), { code: 'PLACEHOLDER_TEXT' });
    }

    await updateOwnedJob({ progress: 'normalizing_transcript' });
    const normalizedTranscript = current?.normalized_transcript
      ?? await normalizeTranscript(recognizedText, claimedJob.language);
    await updateOwnedJob({ normalized_transcript: normalizedTranscript, progress: 'creating_summary' });
    const note = await createSummary(normalizedTranscript, {
      summaryType: claimedJob.summary_type,
      summaryLanguage: claimedJob.summary_language,
    });
    await updateOwnedJob({
      status: 'completed',
      progress: 'completed',
      note_json: JSON.stringify(note),
      error_code: null,
      error_message: null,
      lease_expires_at: null,
      lease_token: null,
    });
  } catch (error) {
    if (error.code === 'JOB_LEASE_LOST') {
      logger.info?.({ jobId: claimedJob.id }, 'Stopped processing after losing the job lease');
      return;
    }
    logger.error?.({ jobId: claimedJob.id, error }, 'Job processing failed');
    const current = await getJob(claimedJob.id, database);
    if (!current || current.lease_token !== claimedJob.lease_token) {
      return;
    }
    const nonRetryableCodes = new Set(['UNSUPPORTED_LANGUAGE', 'ASR_MODEL_UNAVAILABLE', 'MEDIA_MISSING', 'NO_SPEECH_DETECTED', 'PLACEHOLDER_TEXT', 'INVALID_MEDIA_FILE', 'MEDIA_DECODE_FAILED']);
    const isTerminal = current.attempt_count >= config.jobMaxAttempts || nonRetryableCodes.has(error.code);
    const retryDelay = config.jobRetryBaseMs * (2 ** Math.max(0, current.attempt_count - 1));
    if (isTerminal && sourcePath) {
      await removeSource(sourcePath);
      sourcePath = null;
    }
    await updateOwnedJob({
      status: isTerminal ? 'failed' : 'queued',
      progress: isTerminal ? 'failed' : 'queued',
      next_attempt_at: new Date(Date.now() + retryDelay).toISOString(),
      lease_expires_at: null,
      ...(isTerminal ? { source_path: null } : {}),
      error_code: error.code ?? 'PROCESSING_FAILED',
      error_message: String(error.message ?? 'Processing failed').slice(0, 1000),
      lease_token: null,
    });
  } finally {
    clearInterval(heartbeat);
  }
}
