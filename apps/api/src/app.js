import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../../../packages/config/src/config.js';
import { getDatabase, getJob, enqueueJob } from '../../../packages/database/src/database.js';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, SUMMARY_TYPES, publicErrorMessage, publicStatus } from '../../../packages/domain/src/job.js';
import { getMediaDuration } from '../../../packages/media/src/inspect.js';
import { availableVoskLanguages } from '../../../packages/media/src/models.js';
import { providerHealth } from '../../../packages/llm/src/provider.js';
import { hasValidBearerToken } from './auth.js';

const ERROR_SCHEMA = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } },
  required: ['error'],
};

function unauthorized() {
  return { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } };
}

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, content: { type: 'string' } }, required: ['heading', 'content'] } },
    key_points: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string' },
  },
  required: ['title', 'summary', 'sections', 'key_points', 'markdown'],
};

function apiError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseField(fields, name, fallback) {
  const value = fields[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return String(value);
}

function validateOptions(fields, { requiresSpeechModel }) {
  const language = parseField(fields, 'language', 'ru').toLowerCase();
  if (requiresSpeechModel && !availableVoskLanguages().includes(language)) {
    throw apiError(400, 'UNSUPPORTED_LANGUAGE', `Language "${language}" has no installed Vosk model. Available languages: ${availableVoskLanguages().join(', ') || 'none'}`);
  }
  if (!requiresSpeechModel && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw apiError(400, 'INVALID_LANGUAGE', 'language must be a valid language code');
  }
  const summaryType = parseField(fields, 'summary_type', 'detailed');
  if (!SUMMARY_TYPES.includes(summaryType)) {
    throw apiError(400, 'INVALID_SUMMARY_TYPE', `summary_type must be one of: ${SUMMARY_TYPES.join(', ')}`);
  }
  const summaryLanguage = parseField(fields, 'summary_language', language);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(summaryLanguage)) {
    throw apiError(400, 'INVALID_SUMMARY_LANGUAGE', 'summary_language must be a short language code or name');
  }
  return { language, summaryLanguage, summaryType };
}

function createJobRecord({ id, inputKind, text, sourcePath, options }) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.jobRetentionDays * 86400000).toISOString();
  return {
    id,
    status: 'queued',
    input_kind: inputKind,
    input_text: text ?? null,
    source_path: sourcePath ?? null,
    language: options.language,
    summary_language: options.summaryLanguage,
    summary_type: options.summaryType,
    dev_mode: config.isDevelopment ? 1 : 0,
    recognized_text: null,
    normalized_transcript: null,
    note_json: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    next_attempt_at: now,
    lease_expires_at: null,
    progress: 'queued',
    created_at: now,
    updated_at: now,
    expires_at: expiresAt,
  };
}

async function saveUploadedFile(part, id) {
  const originalName = basename(part.filename ?? 'upload').replace(/[\r\n\0]/g, '');
  const extension = extname(originalName).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
    throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file extension "${extension || '(none)'}"`);
  }
  await mkdir(config.uploadDirectory, { recursive: true });
  const targetPath = join(config.uploadDirectory, `${id}${extension}`);
  const stream = createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(part.file, stream);
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  }
  if (part.file.truncated) {
    await rm(targetPath, { force: true });
    throw apiError(413, 'UPLOAD_TOO_LARGE', `Media files may not exceed ${config.maxUploadBytes} bytes`);
  }
  let duration;
  try {
    duration = await getMediaDuration(targetPath, config.ffmpegPath, config.mediaProbeTimeoutMs);
  } catch (error) {
    await rm(targetPath, { force: true });
    throw apiError(400, 'INVALID_MEDIA_FILE', error.message);
  }
  if (duration > config.maxMediaDurationSeconds) {
    await rm(targetPath, { force: true });
    throw apiError(413, 'MEDIA_TOO_LONG', `Media duration exceeds ${config.maxMediaDurationSeconds} seconds`);
  }
  return { targetPath, extension, duration };
}

async function readSubmission(request) {
  const id = randomUUID();
  const fields = {};
  let text;
  let sourcePath;
  let extension;
  try {
    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (sourcePath) {
            throw apiError(400, 'TOO_MANY_FILES', 'Submit at most one media file');
          }
          const saved = await saveUploadedFile(part, id);
          sourcePath = saved.targetPath;
          extension = saved.extension;
        } else {
          fields[part.fieldname] = part.value;
        }
      }
      text = fields.text;
    } else if ((request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      const body = request.body ?? {};
      text = body.text;
      Object.assign(fields, body);
    } else {
      throw apiError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Send application/json text or multipart/form-data media/text');
    }
  } catch (error) {
    if (sourcePath) {
      await rm(sourcePath, { force: true });
    }
    throw error;
  }
  try {
    const options = validateOptions(fields, { requiresSpeechModel: Boolean(sourcePath) });
    if (typeof text === 'string' && text.trim().length > 0 && sourcePath) {
      throw apiError(400, 'AMBIGUOUS_INPUT', 'Submit either text or one media file, not both');
    }
    if (typeof text === 'string' && text.trim().length > 0) {
      const trimmedText = text.trim();
      if (trimmedText.length > config.maxTextChars) {
        throw apiError(413, 'TEXT_TOO_LONG', `Text may not exceed ${config.maxTextChars} characters`);
      }
      return createJobRecord({ id, inputKind: 'text', text: trimmedText, options });
    }
    if (!sourcePath) {
      throw apiError(400, 'INPUT_REQUIRED', 'Provide non-empty text or one video/audio file');
    }
    return createJobRecord({ id, inputKind: VIDEO_EXTENSIONS.has(extension) ? 'video' : 'audio', sourcePath, options });
  } catch (error) {
    if (sourcePath) {
      await rm(sourcePath, { force: true });
    }
    throw error;
  }
}

export async function buildApp() {
  await mkdir(config.uploadDirectory, { recursive: true });
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: config.maxTextChars * 4, trustProxy: config.trustProxy });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    allowList: (request) => ['/healthz', '/readyz'].includes(request.url.split('?')[0]),
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests; retry after the rate limit window.' }),
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 2, fields: 12, fieldSize: 2048 },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'KonspekAI API', description: 'Асинхронное создание структурированных конспектов из видео, аудио и текста.', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API token' } } },
      tags: [
        { name: 'jobs', description: 'Создание и получение конспектов' },
        { name: 'meta', description: 'Справочная информация и проверка готовности' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/v1/jobs')
      && (config.apiAccessToken ? !hasValidBearerToken(request.headers.authorization, config.apiAccessToken) : config.appEnv === 'production')) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(unauthorized());
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests; retry after the rate limit window.' } });
    }
    if (error.statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'UPLOAD_TOO_LARGE', message: `Media files may not exceed ${config.maxUploadBytes} bytes` } });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  app.get('/healthz', { schema: { tags: ['meta'], summary: 'Liveness probe', response: { 200: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { tags: ['meta'], summary: 'Readiness probe', response: { 200: { type: 'object', properties: { status: { type: 'string' }, database: { type: 'string' }, llm_provider: { type: 'string' } }, required: ['status', 'database', 'llm_provider'] }, 503: ERROR_SCHEMA } } }, async (_request, reply) => {
    try {
      await getDatabase().selectFrom('jobs').select('id').limit(1).execute();
      const provider = providerHealth();
      return { status: 'ready', database: 'ok', llm_provider: provider.provider };
    } catch {
      return reply.code(503).send({ error: { code: 'NOT_READY', message: 'Required dependencies are unavailable' } });
    }
  });
  app.get('/api/v1/languages', { schema: { tags: ['meta'], summary: 'List available speech recognition languages', response: { 200: { type: 'object', properties: { languages: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } }, required: ['languages'] } } } }, async () => ({ languages: availableVoskLanguages().map((code) => ({ code })) }));

  app.post('/api/v1/jobs', {
    // Multipart streams have no parsed request.body; validate the request in readSubmission instead.
    validatorCompiler: () => (data) => ({ value: data }),
    schema: {
      tags: ['jobs'],
      summary: 'Create a note generation job',
      security: [{ bearerAuth: [] }],
      description: `JSON accepts text; multipart accepts one media file or text. Supported file extensions: ${[...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].join(', ')}. Maximum upload size: ${config.maxUploadBytes} bytes; maximum media duration: ${config.maxMediaDurationSeconds} seconds; maximum text length: ${config.maxTextChars} characters. For media, language must have an installed Vosk model. summary_language defaults to language.`,
      consumes: ['application/json', 'multipart/form-data'],
      body: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: config.maxTextChars },
          language: { type: 'string', default: 'ru', description: 'Input speech language and installed Vosk model code.' },
          summary_language: { type: 'string', description: 'Language of the generated note; defaults to language.' },
          summary_type: { type: 'string', enum: SUMMARY_TYPES, default: 'detailed' },
          media: { type: 'string', format: 'binary' },
        },
      },
      response: {
        202: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['queued'] }, status_url: { type: 'string' }, result_url: { type: 'string' } }, required: ['id', 'status', 'status_url', 'result_url'] },
        400: ERROR_SCHEMA,
        413: ERROR_SCHEMA,
        415: ERROR_SCHEMA,
        401: ERROR_SCHEMA,
        429: ERROR_SCHEMA,
      },
    },
  }, async (request, reply) => {
    const job = await readSubmission(request);
    try {
      await enqueueJob(job);
    } catch (error) {
      if (job.source_path) {
        await rm(job.source_path, { force: true });
      }
      throw error;
    }
    return reply.code(202).send({ id: job.id, status: 'queued', status_url: `/api/v1/jobs/${job.id}`, result_url: `/api/v1/jobs/${job.id}/result` });
  });

  app.get('/api/v1/jobs/:id', {
    schema: {
      tags: ['jobs'],
      summary: 'Get job status',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] }, progress: { type: 'string' }, attempt: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' }, expires_at: { type: 'string' }, error: ERROR_SCHEMA.properties.error }, required: ['id', 'status', 'progress', 'attempt', 'created_at', 'updated_at', 'expires_at'] }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const job = await getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: 'Job does not exist or has expired' } });
    }
    return publicStatus(job);
  });

  app.get('/api/v1/jobs/:id/result', {
    schema: {
      tags: ['jobs'],
      summary: 'Get generated note',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: {
        200: {
          ...NOTE_SCHEMA,
          additionalProperties: true,
          properties: {
            ...NOTE_SCHEMA.properties,
            recognized_text: { type: 'string' },
            normalized_transcript: { type: 'string' },
          },
        },
        404: ERROR_SCHEMA,
        409: ERROR_SCHEMA,
        401: ERROR_SCHEMA,
        429: ERROR_SCHEMA,
      },
    },
  }, async (request, reply) => {
    const job = await getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: 'Job does not exist or has expired' } });
    }
    if (job.status === 'failed') {
      return reply.code(409).send({ error: { code: job.error_code, message: publicErrorMessage(job.error_code) } });
    }
    if (job.status !== 'completed') {
      return reply.code(409).send({ error: { code: 'JOB_NOT_COMPLETED', message: `Job is currently ${job.status}` } });
    }
    const note = JSON.parse(job.note_json);
    if (!job.dev_mode) {
      return note;
    }
    return {
      recognized_text: job.recognized_text,
      normalized_transcript: job.normalized_transcript,
      ...note,
    };
  });

  app.addHook('onClose', async () => {
    await (await import('../../../packages/database/src/database.js')).closeDatabase();
  });
  return app;
}
