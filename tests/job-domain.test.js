import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_TYPES, publicStatus, validateNote, validateSummaryType } from '../packages/domain/src/job.js';
import { hasValidBearerToken } from '../apps/api/src/auth.js';

test('summary types match the public contract', () => {
  assert.deepEqual(SUMMARY_TYPES, ['detailed', 'brief', 'bullet_points']);
  assert.equal(validateSummaryType('brief'), true);
  assert.equal(validateSummaryType('unknown'), false);
});

test('note validation returns only supported fields', () => {
  const note = validateNote({
    title: 'Заголовок', summary: '', sections: [{ heading: 'Тема', content: 'Текст' }],
    key_points: ['Первый тезис'], markdown: '# Заголовок', ignored: true,
  });
  assert.deepEqual(Object.keys(note), ['title', 'summary', 'sections', 'key_points', 'markdown']);
  assert.deepEqual(validateNote({ title: 'broken' }), {
    title: 'broken', summary: '', sections: [], key_points: [], markdown: '',
  });
});

test('model output may omit Markdown because the service renders it', () => {
  const note = validateNote({ title: 'Тема', summary: '', sections: [], key_points: [] });
  assert.equal(note.markdown, '');
});

test('model section aliases are normalized to the public section contract', () => {
  const note = validateNote({ topic: 'Тема', conclusion: 'Вывод', sections: [{ title: 'Раздел', text: 'Текст' }], points: ['Тезис'] });
  assert.deepEqual(note, {
    title: 'Тема', summary: 'Вывод', sections: [{ heading: 'Раздел', content: 'Текст' }], key_points: ['Тезис'], markdown: '',
  });
});

test('public status does not expose transcript fields', () => {
  const status = publicStatus({
    id: 'job-id', status: 'completed', progress: 'completed', attempt_count: 1,
    created_at: 'a', updated_at: 'b', expires_at: 'c', recognized_text: 'secret transcript',
  });
  assert.equal(status.id, 'job-id');
  assert.equal(Object.hasOwn(status, 'recognized_text'), false);
});

test('bearer API tokens are checked without account identities', () => {
  const token = 'x'.repeat(48);
  assert.equal(hasValidBearerToken(`Bearer ${token}`, token), true);
  assert.equal(hasValidBearerToken('Bearer wrong', token), false);
  assert.equal(hasValidBearerToken(undefined, token), false);
  assert.equal(hasValidBearerToken(`Bearer ${token}`, ''), false);
});
