import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNote, renderMarkdown, splitAtWordBoundary, renderPrompt, summaryQualityProblems, validateNormalizedTranscript } from '../packages/llm/src/pipeline.js';

test('длинный текст разбивается по границам слов без потери содержания', () => {
  const input = 'Восстановление смысла требует аккуратного деления текста на небольшие части. Каждая часть должна оставаться читаемой.';
  const chunks = splitAtWordBoundary(input, 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 24));
  assert.equal(chunks.join(' '), input);
});

test('текст короче заданного предела обрабатывается одним фрагментом', () => {
  assert.deepEqual(splitAtWordBoundary('short text', 24), ['short text']);
});

test('нормализация отклоняет обрезанный ответ и повторённые инструкции', () => {
  assert.throws(() => validateNormalizedTranscript('а'.repeat(100), 'а'.repeat(20)), { code: 'TRANSCRIPT_NORMALIZATION_INCOMPLETE' });
  assert.throws(() => validateNormalizedTranscript('Источник речи.', 'Язык речи: ru. Ниже передана JSON-строка распознанной речи'), { code: 'TRANSCRIPT_NORMALIZATION_INCOMPLETE' });
  assert.equal(validateNormalizedTranscript('Короткая речь.', 'Короткая речь.'), 'Короткая речь.');
});

test('содержательный русский конспект отклоняется при смешении языков или пропущенных разделах', () => {
  const badNote = {
    title: 'Философия Маркса', summary: 'Главная идея — primacy of material conditions.',
    sections: [], key_points: ['Экономика формирует общество.', 'Труд отчуждает человека.', 'Марксизм призывает изменить мир.'],
  };
  assert.deepEqual(summaryQualityProblems(badNote, 'detailed', 'ru'), [
    'too_few_sections', 'too_few_key_points', 'foreign_words_in_russian_summary',
  ]);
});

test('содержательный русский конспект принимается при наличии разделов и тезисов', () => {
  const section = { heading: 'Материализм', content: 'Материальные условия жизни влияют на сознание общества.' };
  const goodNote = {
    title: 'Философия Маркса', summary: 'Маркс анализирует общество через материальные условия жизни. Он связывает перемены с устройством производства.',
    sections: [section, section, section],
    key_points: ['Первично общественное бытие.', 'Экономика составляет основу общества.', 'Философия связана с практикой.', 'Труд может отчуждать человека.'],
  };
  assert.deepEqual(summaryQualityProblems(goodNote, 'detailed', 'ru'), []);
});

test('маркеры списков нормализуются перед формированием Markdown', () => {
  const note = normalizeNote({ title: '', summary: '', sections: [], key_points: ['- Очередь сохраняет работу.'], markdown: '' }, 'Очередь сохраняет задания.', 'bullet_points');
  assert.equal(note.title, 'Очередь сохраняет работу.');
  assert.deepEqual(note.key_points, ['Очередь сохраняет работу.']);
  assert.equal(renderMarkdown(note), '# Очередь сохраняет работу.\n\n## Ключевые тезисы\n\n- Очередь сохраняет работу.');
});

test('шаблоны запросов этапов загружаются из файлов с подстановкой языка', () => {
  const prompt = renderPrompt('normalization.system.txt', { language: 'kk' });
  assert.match(prompt, /языке kk/u);
  assert.match(renderPrompt('summary.brief.system.txt', { language: 'en' }), /краткий учебный конспект/u);
  assert.match(renderPrompt('summary.merge.system.txt', { summary_type: 'detailed' }), /типа detailed/u);
});
