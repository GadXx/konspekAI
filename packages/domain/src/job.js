export const SUMMARY_TYPES = Object.freeze(['detailed', 'brief', 'bullet_points']);
export const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);

export function isPlaceholderText(text) {
  const normalized = text.trim().toLowerCase()
    .replace(/^[\s"'`«»]+|[\s"'`«»]+$/gu, '')
    .replace(/[.,!?;:()[\]{}<>]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return new Set(['string', 'text', 'test', 'example', 'sample', 'your text', 'lorem ipsum', 'foo', 'bar', 'null', 'undefined']).has(normalized);
}

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
    PLACEHOLDER_TEXT: 'The source contains only a placeholder and cannot produce a useful note.',
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
    },
    required: ['title', 'summary', 'sections', 'key_points'],
  };
}

export function validateNote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LLM response must be a JSON object');
  }
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const keyPoints = Array.isArray(value.key_points) ? value.key_points
    : Array.isArray(value.keyPoints) ? value.keyPoints
      : Array.isArray(value.points) ? value.points : [];
  return {
    title: typeof value.title === 'string' ? value.title : typeof value.topic === 'string' ? value.topic : '',
    summary: typeof value.summary === 'string' ? value.summary : typeof value.conclusion === 'string' ? value.conclusion : '',
    sections: sections.map((section) => ({
      heading: typeof section?.heading === 'string' ? section.heading
        : typeof section?.title === 'string' ? section.title
          : typeof section?.name === 'string' ? section.name : '',
      content: typeof section?.content === 'string' ? section.content
        : typeof section?.text === 'string' ? section.text
          : typeof section?.body === 'string' ? section.body : '',
    })).filter((section) => section.heading || section.content),
    key_points: keyPoints.map((point) => typeof point === 'string' ? point
      : typeof point?.text === 'string' ? point.text : '').filter(Boolean),
    markdown: '',
  };
}
