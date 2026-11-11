import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function loadConfig({ role, token, extra = {} }) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./packages/config/src/config.js')"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_ENV: 'production',
      SERVICE_ROLE: role,
      API_ACCESS_TOKEN: token,
      DATABASE_DIALECT: 'sqlite',
      SQLITE_PATH: '.data/config-test.sqlite',
      VOSK_MODELS_JSON: '{"ru":"/models/ru"}',
      ...extra,
    },
  });
}

test('производственный API не запускается без надёжного общего токена Bearer', () => {
  const missing = loadConfig({ role: 'api', token: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /API_ACCESS_TOKEN/u);
  const valid = loadConfig({ role: 'api', token: 'a'.repeat(48) });
  assert.equal(valid.status, 0, valid.stderr);
});

test('производственный worker не получает и не требует токен API', () => {
  const worker = loadConfig({ role: 'worker', token: '' });
  assert.equal(worker.status, 0, worker.stderr);
});

test('провайдер NVIDIA требует ключ только для worker и принимает заданную модель', () => {
  const missing = loadConfig({ role: 'worker', token: '', extra: { LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: '' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /NVIDIA_API_KEY/u);
  const configured = loadConfig({ role: 'worker', token: '', extra: { LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'nvidia-test-key', NVIDIA_MODEL: 'nvidia/nemotron-3.5-lightning-30b-a3b' } });
  assert.equal(configured.status, 0, configured.stderr);
  const api = loadConfig({ role: 'api', token: 'a'.repeat(48), extra: { LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: '' } });
  assert.equal(api.status, 0, api.stderr);
});
