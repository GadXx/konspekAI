import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { buildApp } from '../apps/api/src/app.js';
import {
  closeDatabase,
  completeClaimedJob,
  deleteExpiredJobs,
  getJob,
  claimNextJob,
  updateJob,
  updateClaimedJob,
  recoverExpiredLeases,
  migrate,
} from '../packages/database/src/database.js';

await migrate();
const app = await buildApp();

test('маршруты проверки состояния и списка языков доступны', async () => {
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  const languages = await app.inject({ method: 'GET', url: '/api/v1/languages' });
  assert.equal(languages.statusCode, 200);
  assert.equal(languages.json().languages[0].code, 'ru');
});

test('API отдаёт Vue-приложение и его собранные ресурсы', async () => {
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/u);
  assert.match(page.body, /id="app"/u);
  const scriptPath = page.body.match(/src="([^"]+\.js)"/u)?.[1];
  const stylesPath = page.body.match(/href="([^"]+\.css)"/u)?.[1];
  assert.ok(scriptPath);
  assert.ok(stylesPath);

  for (const path of ['/library', '/library/notes/00000000-0000-4000-8000-000000000000']) {
    const spaRoute = await app.inject({ method: 'GET', url: path });
    assert.equal(spaRoute.statusCode, 200);
    assert.match(spaRoute.headers['content-type'], /text\/html/u);
    assert.match(spaRoute.body, /id="app"/u);
  }

  const script = await app.inject({ method: 'GET', url: scriptPath });
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'], /javascript/u);
  assert.ok(script.body.length > 1000);

  const styles = await app.inject({ method: 'GET', url: stylesPath });
  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers['content-type'], /text\/css/u);

  const missing = await app.inject({ method: 'GET', url: '/assets/..%2Fapp.js' });
  assert.equal(missing.statusCode, 404);
});

test('готовые конспекты сохраняются в библиотеке, а удаление папки удаляет её содержимое', async () => {
  const folderResponse = await app.inject({ method: 'POST', url: '/api/v1/library/folders', payload: { name: 'Философия' } });
  assert.equal(folderResponse.statusCode, 201);
  let folder = folderResponse.json();
  const renameResponse = await app.inject({ method: 'PATCH', url: `/api/v1/library/folders/${folder.id}`, payload: { name: 'Философия и теория' } });
  assert.equal(renameResponse.statusCode, 200);
  folder = renameResponse.json();
  assert.equal(folder.name, 'Философия и теория');

  const createdJob = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: { text: 'Материал о философии.' } });
  const job = await getJob(createdJob.json().id);
  const claimed = await claimNextJob({ leaseSeconds: 60 });
  const summary = {
    title: 'Философия', summary: 'Краткое содержание.', sections: [{ heading: 'Тема', content: 'Материал.' }],
    key_points: ['Главная мысль.'], markdown: '# Философия',
  };
  await completeClaimedJob({ id: job.id, leaseToken: claimed.lease_token, note: summary });

  const initialLibrary = await app.inject({ method: 'GET', url: '/api/v1/library' });
  assert.equal(initialLibrary.statusCode, 200);
  assert.equal(initialLibrary.json().all_count, 1);
  assert.equal(initialLibrary.json().unfiled_count, 1);
  const [savedNote] = initialLibrary.json().notes;

  const move = await app.inject({ method: 'PATCH', url: `/api/v1/library/notes/${savedNote.id}`, payload: { folder_id: folder.id } });
  assert.equal(move.statusCode, 200);
  assert.equal(move.json().folder_id, folder.id);

  const past = new Date(Date.now() - 1000).toISOString();
  await updateJob(job.id, { expires_at: past });
  assert.equal((await deleteExpiredJobs()).length, 1);
  assert.equal(await getJob(job.id), undefined);
  const storedLibrary = await app.inject({ method: 'GET', url: `/api/v1/library?folder_id=${folder.id}` });
  assert.equal(storedLibrary.json().total, 1);
  assert.equal(storedLibrary.json().notes[0].title, 'Философия');

  const secondJobResponse = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: { text: 'Второй материал.' } });
  const secondJob = await getJob(secondJobResponse.json().id);
  const secondClaim = await claimNextJob({ leaseSeconds: 60 });
  await completeClaimedJob({
    id: secondJob.id,
    leaseToken: secondClaim.lease_token,
    note: { ...summary, title: 'Второй конспект' },
  });
  const notesBeforeDelete = await app.inject({ method: 'GET', url: '/api/v1/library?folder_id=unfiled' });
  const unfiledNote = notesBeforeDelete.json().notes[0];
  assert.equal(notesBeforeDelete.json().total, 1);
  const deletedNote = await app.inject({ method: 'DELETE', url: `/api/v1/library/notes/${unfiledNote.id}` });
  assert.equal(deletedNote.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library' })).json().all_count, 1);

  const deletedFolder = await app.inject({ method: 'DELETE', url: `/api/v1/library/folders/${folder.id}` });
  assert.equal(deletedFolder.statusCode, 204);
  const emptyLibrary = await app.inject({ method: 'GET', url: '/api/v1/library' });
  assert.equal(emptyLibrary.json().all_count, 0);
  const missingNote = await app.inject({ method: 'GET', url: `/api/v1/library/notes/${savedNote.id}` });
  assert.equal(missingNote.statusCode, 404);
});

test('текстовый запрос создаёт задание, которое может получить worker', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/jobs',
    payload: { text: 'Важное содержание лекции.', summary_type: 'brief' },
  });
  assert.equal(response.statusCode, 202);
  const job = await getJob(response.json().id);
  assert.equal(job.status, 'queued');
  assert.equal(job.language, 'ru');
  assert.equal(job.summary_type, 'brief');
  const claimed = await claimNextJob({ leaseSeconds: 60 });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.attempt_count, 1);
  assert.ok(claimed.lease_token);
  assert.equal(await updateClaimedJob(job.id, 'stale-lease-token', { progress: 'stale-write' }), undefined);
  const note = { title: 'Очередь задач', summary: '', sections: [], key_points: ['Задачи хранятся в базе.'], markdown: '# Очередь задач' };
  await updateClaimedJob(job.id, claimed.lease_token, {
    status: 'completed', progress: 'completed', recognized_text: 'Распознанный текст.',
    normalized_transcript: 'Нормализованный текст.', note_json: JSON.stringify(note), lease_expires_at: null,
    lease_token: null,
  });
  const result = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}/result` });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().recognized_text, 'Распознанный текст.');
  assert.equal(result.json().normalized_transcript, 'Нормализованный текст.');
  assert.equal(result.json().title, note.title);
});

test('текст-заполнитель отклоняется вместо создания пустого задания', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/jobs', payload: { text: 'string' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'PLACEHOLDER_TEXT');
});

test('неверный язык и неподдерживаемое расширение файла отклоняются', async () => {
  const language = await app.inject({
    method: 'POST', url: '/api/v1/jobs', payload: { text: 'Текст', language: '%' },
  });
  assert.equal(language.statusCode, 400);
  assert.equal(language.json().error.code, 'INVALID_LANGUAGE');

  const file = await app.inject({
    method: 'POST', url: '/api/v1/jobs',
    headers: { 'content-type': 'multipart/form-data; boundary=konspekai-test-boundary' },
    payload: '--konspekai-test-boundary\r\nContent-Disposition: form-data; name="media"; filename="malware.exe"\r\nContent-Type: application/octet-stream\r\n\r\nnot media\r\n--konspekai-test-boundary--\r\n',
  });
  assert.equal(file.statusCode, 415);
});

test('для текстового ввода не требуется модель Vosk для языка конспекта', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/jobs',
    payload: { text: 'This is an English source text.', language: 'en', summary_language: 'en' },
  });
  assert.equal(response.statusCode, 202);
  const job = await getJob(response.json().id);
  assert.equal(job.language, 'en');
  assert.equal(job.summary_language, 'en');
});

test('Swagger UI и спецификация OpenAPI доступны', async () => {
  const docs = await app.inject({ method: 'GET', url: '/docs' });
  assert.equal(docs.statusCode, 200);
  const schema = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(schema.statusCode, 200);
  assert.equal(schema.json().info.title, 'KonspekAI API');
  assert.equal(schema.json().components.securitySchemes.bearerAuth.scheme, 'bearer');
});

test('задания с истёкшей арендой завершаются после предельного числа попыток', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: { text: 'Lease recovery test.' } });
  const job = await getJob(response.json().id);
  await updateJob(job.id, { status: 'processing', attempt_count: 3, lease_token: 'expired-lease-token', lease_expires_at: '2000-01-01T00:00:00.000Z' });
  assert.equal(await recoverExpiredLeases(), 1);
  const recovered = await getJob(job.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error_code, 'WORKER_LEASE_EXPIRED');
  assert.equal(recovered.lease_token, null);
  assert.equal(await updateClaimedJob(job.id, 'expired-lease-token', { status: 'completed' }), undefined);
});

test('чтение библиотеки не ограничивается, а изменение данных сохраняет лимит', async () => {
  const reads = await Promise.all(Array.from({ length: 125 }, () => app.inject({ method: 'GET', url: '/api/v1/library' })));
  assert.ok(reads.every((response) => response.statusCode === 200));

  const responses = await Promise.all(Array.from({ length: 125 }, (_, index) => app.inject({
    method: 'POST', url: '/api/v1/library/folders', payload: { name: `Лимит ${index}` },
  })));
  assert.ok(responses.some((response) => response.statusCode === 429));
  const limited = responses.find((response) => response.statusCode === 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.match(limited.json().error.message, /Слишком много запросов/u);
});

after(async () => {
  await app.close();
  await closeDatabase();
  await rm('.data/konspekai-test.sqlite', { force: true });
  await rm('.data/konspekai-test.sqlite-shm', { force: true });
  await rm('.data/konspekai-test.sqlite-wal', { force: true });
  await rm('.data/test-vosk-model', { force: true, recursive: true });
});
