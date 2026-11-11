import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNote, renderMarkdown, splitAtWordBoundary, renderPrompt, summaryQualityProblems, validateNormalizedTranscript } from '../packages/llm/src/pipeline.js';

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

test('normalization rejects truncated output and echoed prompt instructions', () => {
  assert.throws(() => validateNormalizedTranscript('а'.repeat(100), 'а'.repeat(20)), { code: 'TRANSCRIPT_NORMALIZATION_INCOMPLETE' });
  assert.throws(() => validateNormalizedTranscript('Источник речи.', 'Язык речи: ru. Ниже передана JSON-строка распознанной речи'), { code: 'TRANSCRIPT_NORMALIZATION_INCOMPLETE' });
  assert.equal(validateNormalizedTranscript('Короткая речь.', 'Короткая речь.'), 'Короткая речь.');
});

test('detailed Russian summary rejects mixed languages and missing sections', () => {
  const badNote = {
    title: 'Философия Маркса', summary: 'Главная идея — primacy of material conditions.',
    sections: [], key_points: ['Экономика формирует общество.', 'Труд отчуждает человека.', 'Марксизм призывает изменить мир.'],
  };
  assert.deepEqual(summaryQualityProblems(badNote, 'detailed', 'ru'), [
    'too_few_sections', 'foreign_words_in_russian_summary',
  ]);
});

test('detailed Russian summary accepts complete Russian sections and points', () => {
  const section = { heading: 'Материализм', content: 'Материальные условия жизни влияют на сознание общества.' };
  const goodNote = {
    title: 'Философия Маркса', summary: 'Маркс анализирует общество через материальные условия жизни. Он связывает перемены с устройством производства.',
    sections: [section, section, section],
    key_points: ['Первично общественное бытие.', 'Экономика составляет основу общества.', 'Философия связана с практикой.'],
  };
  assert.deepEqual(summaryQualityProblems(goodNote, 'detailed', 'ru'), []);
});

test('model bullet markers are normalized before Markdown rendering', () => {
  const note = normalizeNote({ title: '', summary: '', sections: [], key_points: ['- Очередь сохраняет работу.'], markdown: '' }, 'Очередь сохраняет задания.', 'bullet_points');
  assert.equal(note.title, 'Очередь сохраняет работу.');
  assert.deepEqual(note.key_points, ['Очередь сохраняет работу.']);
  assert.equal(renderMarkdown(note), '# Очередь сохраняет работу.\n\n## Ключевые тезисы\n\n- Очередь сохраняет работу.');
});

test('stage prompts are loaded from editable templates and substitute language', () => {
  const prompt = renderPrompt('normalization.system.txt', { language: 'kk' });
  assert.match(prompt, /языке kk/u);
  assert.match(renderPrompt('summary.brief.system.txt', { language: 'en' }), /краткий учебный конспект/u);
  assert.match(renderPrompt('summary.merge.system.txt', { summary_type: 'detailed' }), /типа detailed/u);
});
