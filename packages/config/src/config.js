import 'dotenv/config';

function integer(name, fallback, { min = 1 } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

function languageModels() {
  let value;
  try {
    value = JSON.parse(process.env.VOSK_MODELS_JSON ?? '{"ru":"/models/ru"}');
  } catch {
    throw new Error('VOSK_MODELS_JSON must be a JSON object mapping language codes to model paths');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length === 0) {
    throw new Error('VOSK_MODELS_JSON must contain at least one language-to-path mapping');
  }
  return Object.fromEntries(Object.entries(value).map(([language, path]) => [language.toLowerCase(), path]));
}

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const provider = process.env.LLM_PROVIDER ?? 'ollama';
if (!['ollama', 'openai-compatible'].includes(provider)) {
  throw new Error('LLM_PROVIDER must be either "ollama" or "openai-compatible"');
}

export const config = Object.freeze({
  appEnv,
  isDevelopment: appEnv === 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: integer('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseDialect: process.env.DATABASE_DIALECT ?? 'sqlite',
  sqlitePath: process.env.SQLITE_PATH ?? '/data/konspekai.sqlite',
  databaseUrl: process.env.DATABASE_URL,
  databaseBusyTimeoutMs: integer('DATABASE_BUSY_TIMEOUT_MS', 10000),
  uploadDirectory: process.env.UPLOAD_DIRECTORY ?? '/data/uploads',
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 536870912),
  maxTextChars: integer('MAX_TEXT_CHARS', 1000000),
  maxMediaDurationSeconds: integer('MAX_MEDIA_DURATION_SECONDS', 14400),
  workerConcurrency: integer('WORKER_CONCURRENCY', 1),
  jobMaxAttempts: integer('JOB_MAX_ATTEMPTS', 3),
  jobRetryBaseMs: integer('JOB_RETRY_BASE_MS', 5000),
  jobLeaseSeconds: integer('JOB_LEASE_SECONDS', 900),
  jobRetentionDays: integer('JOB_RETENTION_DAYS', 7),
  llmProvider: provider,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? '',
  normalizationModel: process.env.LLM_NORMALIZATION_MODEL,
  summaryModel: process.env.LLM_SUMMARY_MODEL,
  llmTimeoutMs: integer('LLM_TIMEOUT_MS', 180000),
  llmMaxInputChars: integer('LLM_MAX_INPUT_CHARS', 24000),
  llmMaxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 4096),
  voskModels: languageModels(),
  asrSampleRate: integer('ASR_SAMPLE_RATE', 16000),
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  voskLibraryPath: process.env.VOSK_LIBRARY_PATH ?? '/opt/vosk/libvosk.so',
});

if (!['sqlite', 'postgres'].includes(config.databaseDialect)) {
  throw new Error('DATABASE_DIALECT must be "sqlite" or "postgres"');
}
if (config.databaseDialect === 'postgres' && !config.databaseUrl) {
  throw new Error('DATABASE_URL is required when DATABASE_DIALECT=postgres');
}
if (config.databaseDialect === 'sqlite' && config.workerConcurrency > 1) {
  throw new Error('WORKER_CONCURRENCY must be 1 when DATABASE_DIALECT=sqlite');
}
if (config.llmProvider === 'openai-compatible' && (!config.openaiApiKey || !config.openaiModel)) {
  throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required when LLM_PROVIDER=openai-compatible');
}
