import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function loadConfig({ role, token }) {
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
    },
  });
}

test('production API fails fast without a strong shared bearer token', () => {
  const missing = loadConfig({ role: 'api', token: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /API_ACCESS_TOKEN/u);
  const valid = loadConfig({ role: 'api', token: 'a'.repeat(48) });
  assert.equal(valid.status, 0, valid.stderr);
});

test('production worker does not receive or require the API bearer token', () => {
  const worker = loadConfig({ role: 'worker', token: '' });
  assert.equal(worker.status, 0, worker.stderr);
});
