import 'dotenv/config';
import { fileURLToPath } from 'node:url';

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
  return Object.fromEntries(Object.entries(value).map(([language, path]) => {
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) || typeof path !== 'string' || !path.trim()) {
      throw new Error('VOSK_MODELS_JSON must map valid language codes to non-empty filesystem paths');
    }
    return [language.toLowerCase(), path];
  }));
}

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const serviceRole = process.env.SERVICE_ROLE ?? 'api';
const provider = process.env.LLM_PROVIDER ?? 'ollama';
const llmTemperature = Number(process.env.LLM_TEMPERATURE ?? 0.2);
if (!Number.isFinite(llmTemperature) || llmTemperature < 0 || llmTemperature > 2) {
  throw new Error('LLM_TEMPERATURE must be a number between 0 and 2');
}
const trustProxyValue = process.env.TRUST_PROXY ?? 'false';
const trustProxy = trustProxyValue === 'true' ? true
  : trustProxyValue === 'false' ? false
    : Number.isInteger(Number(trustProxyValue)) ? Number(trustProxyValue) : trustProxyValue;
if (!['ollama', 'openai-compatible', 'nvidia'].includes(provider)) {
  throw new Error('LLM_PROVIDER must be "ollama", "openai-compatible", or "nvidia"');
}
if (!['api', 'worker', 'migrate'].includes(serviceRole)) {
  throw new Error('SERVICE_ROLE must be either "api", "worker", or "migrate"');
}

export const config = Object.freeze({
  appEnv,
  serviceRole,
  isDevelopment: appEnv === 'development',
  trustProxy,
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
  orphanUploadRetentionHours: integer('UPLOAD_ORPHAN_RETENTION_HOURS', 24),
  apiAccessToken: process.env.API_ACCESS_TOKEN ?? '',
  rateLimitMax: integer('RATE_LIMIT_MAX', appEnv === 'production' ? 30 : 120),
  rateLimitWindowMs: integer('RATE_LIMIT_WINDOW_MS', 60000),
  llmProvider: provider,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? '',
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
  nvidiaApiKey: process.env.NVIDIA_API_KEY ?? '',
  nvidiaModel: process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
  nvidiaEnableThinking: process.env.NVIDIA_ENABLE_THINKING === 'true',
  nvidiaNormalizationEnableThinking: process.env.NVIDIA_NORMALIZATION_ENABLE_THINKING === 'true',
  nvidiaReasoningBudget: integer('NVIDIA_REASONING_BUDGET', 4096),
  normalizationModel: process.env.LLM_NORMALIZATION_MODEL,
  summaryModel: process.env.LLM_SUMMARY_MODEL,
  llmTimeoutMs: integer('LLM_TIMEOUT_MS', 180000),
  llmMaxInputChars: integer('LLM_MAX_INPUT_CHARS', 24000),
  llmNormalizationMaxInputChars: integer('LLM_NORMALIZATION_MAX_INPUT_CHARS', 4000),
  llmNormalizationMinLengthRatio: Number(process.env.LLM_NORMALIZATION_MIN_LENGTH_RATIO ?? 0.65),
  llmMaxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 4096),
  llmTemperature,
  llmMaxRetries: integer('LLM_MAX_RETRIES', 1, { min: 0 }),
  promptsDirectory: process.env.PROMPTS_DIRECTORY ?? fileURLToPath(new URL('../../llm/prompts/', import.meta.url)),
  mediaProcessTimeoutMs: integer('MEDIA_PROCESS_TIMEOUT_MS', 3600000),
  mediaProbeTimeoutMs: integer('MEDIA_PROBE_TIMEOUT_MS', 30000),
  ffmpegThreads: integer('FFMPEG_THREADS', 2),
  voskModels: languageModels(),
  asrSampleRate: integer('ASR_SAMPLE_RATE', 16000),
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  voskLibraryPath: process.env.VOSK_LIBRARY_PATH ?? '/opt/vosk/libvosk.so',
});

if (!['sqlite', 'postgres'].includes(config.databaseDialect)) {
  throw new Error('DATABASE_DIALECT must be "sqlite" or "postgres"');
}
if (!Number.isFinite(config.llmNormalizationMinLengthRatio) || config.llmNormalizationMinLengthRatio <= 0 || config.llmNormalizationMinLengthRatio > 1) {
  throw new Error('LLM_NORMALIZATION_MIN_LENGTH_RATIO must be greater than 0 and at most 1');
}
if (config.databaseDialect === 'postgres' && !config.databaseUrl) {
  throw new Error('DATABASE_URL is required when DATABASE_DIALECT=postgres');
}
if (config.databaseDialect === 'sqlite' && config.workerConcurrency > 1) {
  throw new Error('WORKER_CONCURRENCY must be 1 when DATABASE_DIALECT=sqlite');
}
if (config.llmProvider === 'openai-compatible' && config.serviceRole === 'worker' && (!config.openaiApiKey || !config.openaiModel)) {
  throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required when LLM_PROVIDER=openai-compatible');
}
if (config.llmProvider === 'nvidia' && config.serviceRole === 'worker' && !config.nvidiaApiKey) {
  throw new Error('NVIDIA_API_KEY is required when LLM_PROVIDER=nvidia');
}
if (config.appEnv === 'production' && config.serviceRole === 'api' && config.apiAccessToken.length < 32) {
  throw new Error('API_ACCESS_TOKEN must contain at least 32 characters when APP_ENV=production');
}
if (config.databaseDialect === 'postgres' && /konspekai:konspekai@/.test(config.databaseUrl ?? '')) {
  throw new Error('DATABASE_URL must not use the example PostgreSQL password');
}
if (config.appEnv === 'production' && config.databaseDialect === 'postgres') {
  let passwordLength = 0;
  try {
    passwordLength = decodeURIComponent(new URL(config.databaseUrl).password).length;
  } catch {
    // Invalid connection URLs are reported by this check as a missing password.
  }
  if (passwordLength < 24) {
    throw new Error('Production PostgreSQL URLs must use a percent-encoded password of at least 24 characters');
  }
}
