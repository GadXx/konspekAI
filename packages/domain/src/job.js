export const SUMMARY_TYPES = Object.freeze(['detailed', 'brief', 'bullet_points']);
export const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);

export function publicStatus(job) {
  const result = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    attempt: job.attempt_count,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
  };
  if (job.status === 'failed') {
    result.error = { code: job.error_code, message: publicErrorMessage(job.error_code) };
  }
  return result;
}

export function publicErrorMessage(code) {
  const safeMessages = {
    INVALID_MEDIA_FILE: 'The uploaded media could not be decoded.',
    MEDIA_DECODE_FAILED: 'The uploaded media could not be decoded.',
    NO_SPEECH_DETECTED: 'No speech was detected in the uploaded media.',
    MEDIA_MISSING: 'The uploaded media is no longer available.',
    UNSUPPORTED_LANGUAGE: 'The requested speech language is not supported.',
    ASR_MODEL_UNAVAILABLE: 'The speech recognition model is temporarily unavailable.',
    WORKER_LEASE_EXPIRED: 'The job could not be completed after repeated worker interruptions.',
  };
  return safeMessages[code] ?? 'The job could not be completed. Contact the service operator with the job ID.';
}

export function validateSummaryType(value) {
  return SUMMARY_TYPES.includes(value);
}

export function noteSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { heading: { type: 'string' }, content: { type: 'string' } },
          required: ['heading', 'content'],
        },
      },
      key_points: { type: 'array', items: { type: 'string' } },
      markdown: { type: 'string' },
    },
    required: ['title', 'summary', 'sections', 'key_points', 'markdown'],
  };
}

export function validateNote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LLM response must be a JSON object');
  }
  if (typeof value.title !== 'string' || typeof value.summary !== 'string' || typeof value.markdown !== 'string') {
    throw new Error('LLM response must include title, summary, and markdown strings');
  }
  if (!Array.isArray(value.sections) || !Array.isArray(value.key_points)) {
    throw new Error('LLM response must include sections and key_points arrays');
  }
  for (const section of value.sections) {
    if (typeof section?.heading !== 'string' || typeof section?.content !== 'string') {
      throw new Error('Each section must contain heading and content strings');
    }
  }
  if (value.key_points.some((point) => typeof point !== 'string')) {
    throw new Error('Each key point must be a string');
  }
  return {
    title: value.title,
    summary: value.summary,
    sections: value.sections,
    key_points: value.key_points,
    markdown: value.markdown,
  };
}
