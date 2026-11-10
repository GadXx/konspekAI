import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNote, renderMarkdown, splitAtWordBoundary } from '../packages/llm/src/pipeline.js';

test('long text is split at word boundaries without loss', () => {
  const input = 'Восстановление смысла требует аккуратного деления текста на небольшие части. Каждая часть должна оставаться читаемой.';
  const chunks = splitAtWordBoundary(input, 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 24));
  assert.equal(chunks.join(' '), input);
});

test('text below the configured threshold stays in one chunk', () => {
  assert.deepEqual(splitAtWordBoundary('short text', 24), ['short text']);
});

test('model bullet markers are normalized before Markdown rendering', () => {
  const note = normalizeNote({ title: '', summary: '', sections: [], key_points: ['- Очередь сохраняет работу.'], markdown: '' }, 'Очередь сохраняет задания.', 'bullet_points');
  assert.equal(note.title, 'Очередь сохраняет работу.');
  assert.deepEqual(note.key_points, ['Очередь сохраняет работу.']);
  assert.equal(renderMarkdown(note), '# Очередь сохраняет работу.\n\n## Ключевые тезисы\n\n- Очередь сохраняет работу.');
});
