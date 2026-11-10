import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { buildApp } from '../apps/api/src/app.js';
import { closeDatabase, getJob, claimNextJob, updateJob, updateClaimedJob, recoverExpiredLeases, migrate } from '../packages/database/src/database.js';

await migrate();
const app = await buildApp();

test('health and language routes are available', async () => {
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  const languages = await app.inject({ method: 'GET', url: '/api/v1/languages' });
  assert.equal(languages.statusCode, 200);
  assert.equal(languages.json().languages[0].code, 'ru');
});

test('text submission returns an asynchronous job and can be claimed by a worker', async () => {
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

test('invalid language and unsupported media extensions are rejected', async () => {
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

test('text input can use an output language without requiring a matching Vosk model', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/jobs',
    payload: { text: 'This is an English source text.', language: 'en', summary_language: 'en' },
  });
  assert.equal(response.statusCode, 202);
  const job = await getJob(response.json().id);
  assert.equal(job.language, 'en');
  assert.equal(job.summary_language, 'en');
});

test('Swagger UI and OpenAPI document are mounted', async () => {
  const docs = await app.inject({ method: 'GET', url: '/docs' });
  assert.equal(docs.statusCode, 200);
  const schema = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(schema.statusCode, 200);
  assert.equal(schema.json().info.title, 'KonspekAI API');
  assert.equal(schema.json().components.securitySchemes.bearerAuth.scheme, 'bearer');
});

test('expired leases become terminal after the configured attempt limit', async () => {
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

test('requests are rate limited with the documented error contract', async () => {
  const responses = await Promise.all(Array.from({ length: 125 }, () => app.inject({ method: 'GET', url: '/api/v1/languages' })));
  assert.ok(responses.some((response) => response.statusCode === 429));
  const limited = responses.find((response) => response.statusCode === 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
});

after(async () => {
  await app.close();
  await closeDatabase();
  await rm('.data/konspekai-test.sqlite', { force: true });
  await rm('.data/konspekai-test.sqlite-shm', { force: true });
  await rm('.data/konspekai-test.sqlite-wal', { force: true });
  await rm('.data/test-vosk-model', { force: true, recursive: true });
});
