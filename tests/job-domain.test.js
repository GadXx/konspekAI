import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_TYPES, publicStatus, validateNote, validateSummaryType } from '../packages/domain/src/job.js';

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
  assert.throws(() => validateNote({ title: 'broken' }), /title, summary, and markdown/);
});

test('public status does not expose transcript fields', () => {
  const status = publicStatus({
    id: 'job-id', status: 'completed', progress: 'completed', attempt_count: 1,
    created_at: 'a', updated_at: 'b', expires_at: 'c', recognized_text: 'secret transcript',
  });
  assert.equal(status.id, 'job-id');
  assert.equal(Object.hasOwn(status, 'recognized_text'), false);
});
