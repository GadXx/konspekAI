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
  properties: { error: { type: 'object', description: 'Описание ошибки API.', properties: { code: { type: 'string', description: 'Стабильный машинный код ошибки.' }, message: { type: 'string', description: 'Понятное описание ошибки на русском языке.' } }, required: ['code', 'message'] } },
  required: ['error'],
};
const WEB_DIRECTORY = fileURLToPath(new URL('../../web/dist/', import.meta.url));

function unauthorized() {
  return { error: { code: 'UNAUTHORIZED', message: 'Для доступа требуется действительный токен Bearer' } };
}

const NOTE_SCHEMA = {
  type: 'object',
  description: 'Структурированный конспект с Markdown-представлением.',
  properties: {
    title: { type: 'string', description: 'Заголовок конспекта.' },
    summary: { type: 'string', description: 'Краткое содержание материала.' },
    sections: { type: 'array', description: 'Тематические разделы в порядке изложения.', items: { type: 'object', properties: { heading: { type: 'string', description: 'Заголовок раздела.' }, content: { type: 'string', description: 'Содержание раздела.' } }, required: ['heading', 'content'] } },
    key_points: { type: 'array', description: 'Основные выводы и факты.', items: { type: 'string' } },
    markdown: { type: 'string', description: 'Готовое представление конспекта в Markdown.' },
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
    throw apiError(400, 'UNSUPPORTED_LANGUAGE', `Для языка «${language}» не установлена модель Vosk. Доступные языки: ${availableVoskLanguages().join(', ') || 'нет'}`);
  }
  if (!requiresSpeechModel && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw apiError(400, 'INVALID_LANGUAGE', 'Поле language должно содержать корректный код языка');
  }
  const summaryType = parseField(fields, 'summary_type', 'detailed');
  if (!SUMMARY_TYPES.includes(summaryType)) {
    throw apiError(400, 'INVALID_SUMMARY_TYPE', `Поле summary_type должно иметь одно из значений: ${SUMMARY_TYPES.join(', ')}`);
  }
  const summaryLanguage = parseField(fields, 'summary_language', language);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(summaryLanguage)) {
    throw apiError(400, 'INVALID_SUMMARY_LANGUAGE', 'Поле summary_language должно содержать короткий код языка или его название');
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
    throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Формат файла «${extension || '(не указан)'}» не поддерживается`);
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
    throw apiError(413, 'UPLOAD_TOO_LARGE', `Размер медиафайла не должен превышать ${config.maxUploadBytes} байт`);
  }
  let duration;
  try {
    duration = await getMediaDuration(targetPath, config.ffmpegPath, config.mediaProbeTimeoutMs);
  } catch {
    await rm(targetPath, { force: true });
    throw apiError(400, 'INVALID_MEDIA_FILE', 'Не удалось прочитать медиафайл. Проверьте его формат и целостность.');
  }
  if (duration > config.maxMediaDurationSeconds) {
    await rm(targetPath, { force: true });
    throw apiError(413, 'MEDIA_TOO_LONG', `Длительность записи превышает ${config.maxMediaDurationSeconds} секунд`);
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
            throw apiError(400, 'TOO_MANY_FILES', 'Можно загрузить только один медиафайл');
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
      throw apiError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Для текста используйте application/json, для файла — multipart/form-data');
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
      throw apiError(400, 'AMBIGUOUS_INPUT', 'Отправьте либо текст, либо один медиафайл');
    }
    if (typeof text === 'string' && text.trim().length > 0) {
      const trimmedText = text.trim();
      if (isPlaceholderText(trimmedText)) {
        throw apiError(400, 'PLACEHOLDER_TEXT', 'Замените текст-заполнитель настоящим текстом или расшифровкой записи');
      }
      if (trimmedText.length > config.maxTextChars) {
        throw apiError(413, 'TEXT_TOO_LONG', `Текст не должен превышать ${config.maxTextChars} символов`);
      }
      return createJobRecord({ id, inputKind: 'text', text: trimmedText, options });
    }
    if (!sourcePath) {
      throw apiError(400, 'INPUT_REQUIRED', 'Добавьте текст или один видео- либо аудиофайл');
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
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Слишком много запросов', message: 'Слишком много запросов на изменение данных. Повторите попытку позже.' }),
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 2, fields: 12, fieldSize: 2048 },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'KonspekAI API', description: 'Асинхронное создание структурированных конспектов из видео, аудио и текста.', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API token' } } },
      tags: [
        { name: 'Задания', description: 'Создание заданий и получение их результатов' },
        { name: 'Библиотека', description: 'Постоянное хранение конспектов и папок' },
        { name: 'Справка', description: 'Список языков и проверка готовности сервиса' },
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
      return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Файл интерфейса не найден' } });
    }
    try {
      const content = await readFile(join(WEB_DIRECTORY, 'assets', asset));
      const contentType = asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      return reply.type(contentType).header('cache-control', 'public, max-age=300').send(content);
    } catch {
      return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Файл интерфейса не найден' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Слишком много запросов на изменение данных. Повторите попытку позже.' } });
    }
    if (error.statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'UPLOAD_TOO_LARGE', message: `Размер медиафайла не должен превышать ${config.maxUploadBytes} байт` } });
    }
    if (error.statusCode && error.statusCode < 500) {
      const message = error.validation
        ? 'Проверьте параметры запроса и соответствие данных формату API'
        : error.message;
      return reply.code(error.statusCode).send({ error: { code: error.code ?? 'INVALID_REQUEST', message } });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Произошла непредвиденная ошибка' } });
  });

  app.get('/healthz', { schema: { tags: ['Справка'], summary: 'Проверка работоспособности', response: { 200: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { tags: ['Справка'], summary: 'Проверка готовности к работе', response: { 200: { type: 'object', properties: { status: { type: 'string' }, database: { type: 'string' }, llm_provider: { type: 'string' } }, required: ['status', 'database', 'llm_provider'] }, 503: ERROR_SCHEMA } } }, async (_request, reply) => {
    try {
      await getDatabase().selectFrom('jobs').select('id').limit(1).execute();
      const provider = providerHealth();
      return { status: 'ready', database: 'ok', llm_provider: provider.provider };
    } catch {
      return reply.code(503).send({ error: { code: 'NOT_READY', message: 'Не удалось подключиться к обязательным компонентам сервиса' } });
    }
  });
  app.get('/api/v1/languages', { schema: { tags: ['Справка'], summary: 'Языки с установленными моделями распознавания', response: { 200: { type: 'object', properties: { languages: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } }, required: ['languages'] } } } }, async () => ({ languages: availableVoskLanguages().map((code) => ({ code })) }));

  app.get('/api/v1/library', {
    schema: {
      tags: ['Библиотека'],
      summary: 'Список сохранённых конспектов и папок',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: 'Идентификатор папки или значение unfiled для конспектов без папки. Если не задано, возвращаются все конспекты.' },
          q: { type: 'string', maxLength: 200, description: 'Поиск по заголовкам и краткому содержанию.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Количество элементов на странице.' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Число элементов, которое нужно пропустить.' },
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
      tags: ['Библиотека'], summary: 'Получить сохранённый конспект', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { ...NOTE_SCHEMA, additionalProperties: true, properties: { ...NOTE_SCHEMA.properties, id: { type: 'string', format: 'uuid' }, folder_id: { type: ['string', 'null'], format: 'uuid' }, summary_type: { type: 'string', enum: SUMMARY_TYPES }, language: { type: 'string' }, summary_language: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const note = await getLibraryNote(request.params.id);
    if (!note) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Конспект не найден или был удалён' } });
    }
    const { sections_json: _sectionsJson, key_points_json: _keyPointsJson, source_job_id: _sourceJobId, ...publicNote } = note;
    return publicNote;
  });

  app.delete('/api/v1/library/notes/:id', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    schema: { tags: ['Библиотека'], summary: 'Удалить конспект без возможности восстановления', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }, response: { 204: { type: 'null' }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA } },
  }, async (request, reply) => {
    const deleted = await deleteLibraryNote(request.params.id);
    if (Number(deleted.numDeletedRows) === 0) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Конспект не найден или был удалён' } });
    }
    return reply.code(204).send();
  });

  app.patch('/api/v1/library/notes/:id', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    schema: {
      tags: ['Библиотека'], summary: 'Переместить конспект в папку или в раздел без папки', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { folder_id: { type: ['string', 'null'], format: 'uuid' } }, required: ['folder_id'], additionalProperties: false },
      response: { 200: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, folder_id: { type: ['string', 'null'], format: 'uuid' }, updated_at: { type: 'string', format: 'date-time' } }, required: ['id', 'updated_at'] }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    if (request.body.folder_id) {
      const folder = await getDatabase().selectFrom('library_folders').select('id').where('id', '=', request.body.folder_id).executeTakeFirst();
      if (!folder) {
        return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Папка не найдена или была удалена' } });
      }
    }
    const note = await moveLibraryNote(request.params.id, request.body.folder_id);
    if (!note) {
      return reply.code(404).send({ error: { code: 'NOTE_NOT_FOUND', message: 'Конспект не найден или был удалён' } });
    }
    return { id: note.id, folder_id: note.folder_id, updated_at: note.updated_at };
  });

  app.post('/api/v1/library/folders', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    schema: {
      tags: ['Библиотека'], summary: 'Создать папку', security: [{ bearerAuth: [] }],
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false },
      response: { 201: LIBRARY_FOLDER_SCHEMA, 400: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name || name.length > 80) {
      throw apiError(400, 'INVALID_FOLDER_NAME', 'Название папки должно содержать от 1 до 80 символов');
    }
    return reply.code(201).send(await createLibraryFolder({ id: randomUUID(), name }));
  });

  app.patch('/api/v1/library/folders/:id', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    schema: {
      tags: ['Библиотека'], summary: 'Переименовать папку', security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false },
      response: { 200: LIBRARY_FOLDER_SCHEMA, 400: ERROR_SCHEMA, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name || name.length > 80) {
      throw apiError(400, 'INVALID_FOLDER_NAME', 'Название папки должно содержать от 1 до 80 символов');
    }
    const folder = await renameLibraryFolder(request.params.id, name);
    if (!folder) {
      return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Папка не найдена или была удалена' } });
    }
    return folder;
  });

  app.delete('/api/v1/library/folders/:id', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    schema: { tags: ['Библиотека'], summary: 'Удалить папку и все конспекты в ней без возможности восстановления', security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], description: 'Идентификатор папки в формате UUID.' }, response: { 204: { type: 'null' }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA, 429: ERROR_SCHEMA } },
  }, async (request, reply) => {
    const deleted = await deleteLibraryFolder(request.params.id);
    if (Number(deleted.numDeletedRows) === 0) {
      return reply.code(404).send({ error: { code: 'FOLDER_NOT_FOUND', message: 'Папка не найдена или была удалена' } });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/jobs', {
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs } },
    // Multipart streams have no parsed request.body; validate the request in readSubmission instead.
    validatorCompiler: () => (data) => ({ value: data }),
    schema: {
      tags: ['Задания'],
      summary: 'Создать задание на составление конспекта',
      security: [{ bearerAuth: [] }],
      description: `Отправьте текст в формате JSON или один видео-/аудиофайл через multipart/form-data. Поддерживаемые расширения: ${[...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].join(', ')}. Максимальный размер файла: ${config.maxUploadBytes} байт; максимальная длительность записи: ${config.maxMediaDurationSeconds} секунд; максимальный объём текста: ${config.maxTextChars} символов. Для медиафайла требуется установленная модель Vosk для выбранного языка. Если summary_language не задано, используется language.`,
      consumes: ['application/json', 'multipart/form-data'],
      body: {
        type: 'object',
        properties: {
          text: {
            type: 'string', maxLength: config.maxTextChars,
            example: 'Искусственный интеллект помогает анализировать данные. Результаты нужно проверять перед использованием.',
            description: 'Исходный текст или расшифровка записи. Тестовые значения и заполнители, например string и test, отклоняются.',
          },
          language: { type: 'string', default: 'ru', description: 'Язык исходной речи и код установленной модели Vosk.' },
          summary_language: { type: 'string', description: 'Язык готового конспекта. По умолчанию совпадает с language.' },
          summary_type: { type: 'string', enum: SUMMARY_TYPES, default: 'detailed', description: 'Глубина и форма конспекта.' },
          media: { type: 'string', format: 'binary', description: 'Один видео- или аудиофайл допустимого формата.' },
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
      tags: ['Задания'],
      summary: 'Получить состояние задания',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] }, progress: { type: 'string' }, attempt: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' }, expires_at: { type: 'string' }, error: ERROR_SCHEMA.properties.error }, required: ['id', 'status', 'progress', 'attempt', 'created_at', 'updated_at', 'expires_at'] }, 404: ERROR_SCHEMA, 401: ERROR_SCHEMA },
    },
  }, async (request, reply) => {
    const job = await getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: 'Задание не найдено или срок его хранения истёк' } });
    }
    return publicStatus(job);
  });

  app.get('/api/v1/jobs/:id/result', {
    schema: {
      tags: ['Задания'],
      summary: 'Получить готовый конспект',
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
      },
    },
  }, async (request, reply) => {
    const job = await getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: 'Задание не найдено или срок его хранения истёк' } });
    }
    if (job.status === 'failed') {
      return reply.code(409).send({ error: { code: job.error_code, message: publicErrorMessage(job.error_code) } });
    }
    if (job.status !== 'completed') {
      return reply.code(409).send({ error: { code: 'JOB_NOT_COMPLETED', message: `Задание ещё выполняется. Текущее состояние: ${job.status}` } });
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

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (request.method === 'GET' && (/^\/library\/?$/.test(pathname) || /^\/library\/notes\/[^/]+\/?$/.test(pathname))) {
      return reply.type('text/html; charset=utf-8').send(await readFile(join(WEB_DIRECTORY, 'index.html')));
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } });
  });

  app.addHook('onClose', async () => {
    await (await import('../../../packages/database/src/database.js')).closeDatabase();
  });
  return app;
}
