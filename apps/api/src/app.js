import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { config } from '../../../packages/config/src/config.js';
import {
  createLibraryFolder,
  countLibraryNotes,
  deleteLibraryFolder,
  deleteLibraryNote,
  getDatabase,
  getJob,
  getLibraryNote,
  enqueueJob,
  listLibraryFolders,
  listLibraryNotes,
  moveLibraryNote,
  renameLibraryFolder,
} from '../../../packages/database/src/database.js';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, SUMMARY_TYPES, isPlaceholderText, publicErrorMessage, publicStatus } from '../../../packages/domain/src/job.js';
import { getMediaDuration } from '../../../packages/media/src/inspect.js';
import { availableVoskLanguages } from '../../../packages/media/src/models.js';
import { providerHealth } from '../../../packages/llm/src/provider.js';
import { hasValidBearerToken } from './auth.js';

const ERROR_SCHEMA = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } },
  required: ['error'],
};
const WEB_DIRECTORY = fileURLToPath(new URL('../../web/dist/', import.meta.url));

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
const LIBRARY_FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    note_count: { type: 'integer' },
  },
  required: ['id', 'name', 'created_at', 'updated_at'],
};
const LIBRARY_NOTE_LIST_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    folder_id: { type: ['string', 'null'], format: 'uuid' },
    title: { type: 'string' },
    summary: { type: 'string' },
    summary_type: { type: 'string', enum: SUMMARY_TYPES },
    language: { type: 'string' },
    summary_language: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'title', 'summary', 'summary_type', 'language', 'summary_language', 'created_at', 'updated_at'],
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
      if (isPlaceholderText(trimmedText)) {
        throw apiError(400, 'PLACEHOLDER_TEXT', 'Replace the placeholder with the actual source text or transcript');
      }
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
        { name: 'library', description: 'Постоянная библиотека сохранённых конспектов и папок' },
        { name: 'meta', description: 'Справочная информация и проверка готовности' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.addHook('onRequest', async (request, reply) => {
    if ((request.url.startsWith('/api/v1/jobs') || request.url.startsWith('/api/v1/library'))
      && (config.apiAccessToken ? !hasValidBearerToken(request.headers.authorization, config.apiAccessToken) : config.appEnv === 'production')) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(unauthorized());
    }
  });

  app.get('/', { schema: { hide: true } }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(await readFile(join(WEB_DIRECTORY, 'index.html')));
  });
  app.get('/assets/*', { schema: { hide: true } }, async (request, reply) => {
    const asset = request.params['*'];
    if (!/^[a-zA-Z0-9_./-]+$/.test(asset) || asset.split('/').includes('..')) {
      return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
    }
    try {
      const content = await readFile(join(WEB_DIRECTORY, 'assets', asset));
      const contentType = asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      return reply.type(contentType).header('cache-control', 'public, max-age=300').send(content);
    } catch {
      return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
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

  app.get('/api/v1/library', {
    schema: {
      tags: ['library'],
      summary: 'List saved notes and folders',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: 'Filter by folder ID or "unfiled". Omit to list all notes.' },
          q: { type: 'string', maxLength: 200, description: 'Search note titles and summaries.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            folders: { type: 'array', items: LIBRARY_FOLDER_SCHEMA },
            notes: { type: 'array', items: LIBRARY_NOTE_LIST_SCHEMA },
            total: { type: 'integer' },
            all_count: { type: 'integer' },
            unfiled_count: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['folders', 'notes', 'total', 'all_count', 'unfiled_count', 'limit', 'offset'],
        },
        401: ERROR_SCHEMA,
      },
    },
  }, async (request) => {
    const { folder_id: folderId, q } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    return {
      folders: await listLibraryFolders(),
      notes: await listLibraryNotes({ folderId, query: typeof q === 'string' ? q.trim().slice(0, 200) : undefined, limit, offset }),
      total: await countLibraryNotes({ folderId, query: typeof q === 'string' ? q.trim().slice(0, 200) : undefined }),
      all_count: await countLibraryNotes(),
      unfiled_count: await countLibraryNotes({ folderId: 'unfiled' }),
      limit,
      offset,
    };
  });

  app.get('/api/v1/library/notes/:id', {
    schema: {
      tags: ['library'], summary: 'Get a saved note', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { ...NOTE_SCHEMA, additionalProperties: true, properties: { ...NOTE_SCHEMA.properties, id: { type: 'string', format: 'uuid' }, folder_id: { type: ['string', 'null'], format: 'uuid' }, summary_type: { type: 'string', enum: SUMMARY_TYPES }, language: { type: 'string' }, summary_language: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const note = await getLibraryNote(request.params.id);
    if (!note) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Saved note does not exist' } });
    }
    const { sections_json: _sectionsJson, key_points_json: _keyPointsJson, source_job_id: _sourceJobId, ...publicNote } = note;
    return publicNote;
  });

  app.delete('/api/v1/library/notes/:id', {
    schema: { tags: ['library'], summary: 'Delete a saved note permanently', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }, response: { 204: { type: 'null' }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA } },
  }, async (request, reply) => {
    const deleted = await deleteLibraryNote(request.params.id);
    if (Number(deleted.numDeletedRows) === 0) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Saved note does not exist' } });
    }
    return reply.code(204).send();
  });

  app.patch('/api/v1/library/notes/:id', {
    schema: {
      tags: ['library'], summary: 'Move a saved note to a folder or to the unfiled section', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { folder_id: { type: ['string', 'null'], format: 'uuid' } }, required: ['folder_id'], additionalProperties: false },
      response: { 200: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, folder_id: { type: ['string', 'null'], format: 'uuid' }, updated_at: { type: 'string', format: 'date-time' } }, required: ['id', 'updated_at'] }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    if (request.body.folder_id) {
      const folder = await getDatabase().selectFrom('library_folders').select('id').where('id', '=', request.body.folder_id).executeTakeFirst();
      if (!folder) {
        return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Folder does not exist' } });
      }
    }
    const note = await moveLibraryNote(request.params.id, request.body.folder_id);
    if (!note) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Saved note does not exist' } });
    }
    return { id: note.id, folder_id: note.folder_id, updated_at: note.updated_at };
  });

  app.post('/api/v1/library/folders', {
    schema: {
      tags: ['library'], summary: 'Create a library folder', security: [{ bearerAuth: [] }],
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false },
      response: { 201: LIBRARY_FOLDER_SCHEMA, 400: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name || name.length > 80) {
      throw apiError(400, 'INVALID_FOLDER_NAME', 'Folder name must contain 1 to 80 characters');
    }
    return reply.code(201).send(await createLibraryFolder({ id: randomUUID(), name }));
  });

  app.patch('/api/v1/library/folders/:id', {
    schema: {
      tags: ['library'], summary: 'Rename a library folder', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false },
      response: { 200: LIBRARY_FOLDER_SCHEMA, 400: ERROR_SCHEMA, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name || name.length > 80) {
      throw apiError(400, 'INVALID_FOLDER_NAME', 'Folder name must contain 1 to 80 characters');
    }
    const folder = await renameLibraryFolder(request.params.id, name);
    if (!folder) {
      return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Folder does not exist' } });
    }
    return folder;
  });

  app.delete('/api/v1/library/folders/:id', {
    schema: { tags: ['library'], summary: 'Permanently delete a folder and all saved notes inside it', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }, response: { 204: { type: 'null' }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA } },
  }, async (request, reply) => {
    const deleted = await deleteLibraryFolder(request.params.id);
    if (Number(deleted.numDeletedRows) === 0) {
      return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Folder does not exist' } });
    }
    return reply.code(204).send();
  });

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
          text: {
            type: 'string', maxLength: config.maxTextChars,
            example: 'Искусственный интеллект помогает анализировать данные. Результаты нужно проверять перед использованием.',
            description: 'Actual source text or transcript. Placeholder values such as "string" and "test" are rejected.',
          },
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
