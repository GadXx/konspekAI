import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_TYPES, isPlaceholderText, publicStatus, validateNote, validateSummaryType } from '../packages/domain/src/job.js';

test('проверка распознаёт заполнители API и не отклоняет обычный исходный текст', () => {
  assert.equal(isPlaceholderText('"string"'), true);
  assert.equal(isPlaceholderText('TEST.'), true);
  assert.equal(isPlaceholderText('Тема лекции о строковом типе данных.'), false);
});
import { hasValidBearerToken } from '../apps/api/src/auth.js';

test('типы конспектов соответствуют публичному контракту', () => {
  assert.deepEqual(SUMMARY_TYPES, ['detailed', 'brief', 'bullet_points']);
  assert.equal(validateSummaryType('brief'), true);
  assert.equal(validateSummaryType('unknown'), false);
});

test('проверка конспекта оставляет только поддерживаемые поля', () => {
  const note = validateNote({
    title: 'Заголовок', summary: '', sections: [{ heading: 'Тема', content: 'Текст' }],
    key_points: ['Первый тезис'], markdown: '# Заголовок', ignored: true,
  });
  assert.deepEqual(Object.keys(note), ['title', 'summary', 'sections', 'key_points', 'markdown']);
  assert.deepEqual(validateNote({ title: 'broken' }), {
    title: 'broken', summary: '', sections: [], key_points: [], markdown: '',
  });
});

test('модель может не возвращать Markdown, поскольку его формирует сервис', () => {
  const note = validateNote({ title: 'Тема', summary: '', sections: [], key_points: [] });
  assert.equal(note.markdown, '');
});

test('альтернативные названия разделов приводятся к публичному контракту', () => {
  const note = validateNote({ topic: 'Тема', conclusion: 'Вывод', sections: [{ title: 'Раздел', text: 'Текст' }], points: ['Тезис'] });
  assert.deepEqual(note, {
    title: 'Тема', summary: 'Вывод', sections: [{ heading: 'Раздел', content: 'Текст' }], key_points: ['Тезис'], markdown: '',
  });
});

test('публичное состояние задания не раскрывает тексты расшифровки', () => {
  const status = publicStatus({
    id: 'job-id', status: 'completed', progress: 'completed', attempt_count: 1,
    created_at: 'a', updated_at: 'b', expires_at: 'c', recognized_text: 'secret transcript',
  });
  assert.equal(status.id, 'job-id');
  assert.equal(Object.hasOwn(status, 'recognized_text'), false);
});

test('токен Bearer проверяется без привязки к учётной записи', () => {
  const token = 'x'.repeat(48);
  assert.equal(hasValidBearerToken(`Bearer ${token}`, token), true);
  assert.equal(hasValidBearerToken('Bearer wrong', token), false);
  assert.equal(hasValidBearerToken(undefined, token), false);
  assert.equal(hasValidBearerToken(`Bearer ${token}`, ''), false);
});
