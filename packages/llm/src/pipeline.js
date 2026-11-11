import { config } from '../../config/src/config.js';
import { noteSchema, validateNote } from '../../domain/src/job.js';
import { completeJson } from './provider.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NORMALIZATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { transcript: { type: 'string' } },
  required: ['transcript'],
};

const promptCache = new Map();
const PROMPT_FILES = [
  'normalization.system.txt',
  'normalization.user.txt',
  'summary.detailed.system.txt',
  'summary.brief.system.txt',
  'summary.bullet_points.system.txt',
  'summary.user.txt',
  'summary.merge.system.txt',
  'summary.merge.user.txt',
  'summary.reduce.system.txt',
  'summary.reduce.user.txt',
];

export function renderPrompt(name, values = {}) {
  if (!promptCache.has(name)) {
    promptCache.set(name, readFileSync(join(config.promptsDirectory, name), 'utf8').trim());
  }
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), promptCache.get(name));
}

for (const promptFile of PROMPT_FILES) {
  renderPrompt(promptFile);
}

function splitAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < maxChars * 0.55) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt < maxChars * 0.55) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function renderMarkdown(note) {
  const sections = note.sections
    .filter((section) => section.content.trim())
    .map((section) => `## ${section.heading}\n\n${section.content}`).join('\n\n');
  const keyPoints = note.key_points.length > 0 ? `## Ключевые тезисы\n\n${note.key_points.map((point) => `- ${point.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}`).join('\n')}` : '';
  return [`# ${note.title}`, note.summary, sections, keyPoints].filter(Boolean).join('\n\n').trim();
}

export function normalizeNote(note, sourceText, summaryType) {
  const firstPoint = note.key_points.find((point) => point.trim());
  const firstSentence = sourceText.trim().split(/(?<=[.!?])\s+/u)[0]?.slice(0, 100);
  const title = note.title.trim()
    || firstPoint?.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').slice(0, 80).trim()
    || firstSentence
    || 'Конспект';
  const keyPoints = note.key_points
    .map((point) => point.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  const sections = note.sections
    .map((section) => ({ heading: section.heading.trim(), content: section.content.trim() }))
    .filter((section) => section.content);
  const summary = note.summary.trim()
    || (summaryType === 'bullet_points' ? '' : sections.map((section) => section.content).filter(Boolean).join('\n\n') || keyPoints.join(' '));
  return { ...note, title, summary, sections, key_points: keyPoints };
}

function compactNote(note) {
  return {
    title: note.title,
    summary: note.summary,
    sections: note.sections,
    key_points: note.key_points,
  };
}

async function normalizeChunk(text, language) {
  const result = await completeJson({
    stage: 'normalization',
    schema: NORMALIZATION_SCHEMA,
    maxTokens: Math.min(config.llmMaxOutputTokens, Math.ceil(text.length / 2) + 200),
    messages: [
      { role: 'system', content: renderPrompt('normalization.system.txt', { language }) },
      { role: 'user', content: renderPrompt('normalization.user.txt', { language, payload_json: JSON.stringify(text) }) },
    ],
  });
  if (typeof result.transcript !== 'string' || !result.transcript.trim()) {
    throw new Error('LLM returned an empty normalized transcript');
  }
  return result.transcript.trim();
}

async function summarizeChunk(text, { summaryType, summaryLanguage }, mode = 'transcript', strictQuality = false) {
  const isTranscript = mode === 'transcript';
  let systemPrompt = isTranscript
    ? renderPrompt(`summary.${summaryType}.system.txt`, { language: summaryLanguage })
    : `${renderPrompt(`summary.${summaryType}.system.txt`, { language: summaryLanguage })}\n\n${renderPrompt(`summary.${mode}.system.txt`, { summary_type: summaryType })}`;
  if (strictQuality) {
    systemPrompt += `\n\nПРЕДЫДУЩИЙ РЕЗУЛЬТАТ НЕ ПРОШЁЛ ПРОВЕРКУ КАЧЕСТВА. Создай ответ заново на языке «${summaryLanguage}». Не используй английские или другие иностранные слова и фразы. Для типа detailed обязательно верни не менее трёх непустых тематических разделов, summary из нескольких законченных предложений и не менее трёх key_points. Не оставляй поля пустыми, если формат требует их заполнить. Перед ответом проверь, что весь текст написан на языке «${summaryLanguage}» и что каждый раздел содержит полезное содержание.`;
  }
  const result = await completeJson({
    stage: 'summary',
    schema: noteSchema(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: renderPrompt(isTranscript ? 'summary.user.txt' : `summary.${mode}.user.txt`, { language: summaryLanguage, summary_type: summaryType, payload_json: JSON.stringify(text) }) },
    ],
  });
  return normalizeNote(validateNote(result), text, summaryType);
}

export async function normalizeTranscript(text, language) {
  const chunks = splitAtWordBoundary(text, config.llmNormalizationMaxInputChars);
  const normalized = [];
  for (const chunk of chunks) {
    normalized.push(await normalizeChunk(chunk, language));
  }
  return validateNormalizedTranscript(text, normalized.join('\n\n'));
}

export function validateNormalizedTranscript(sourceText, transcript) {
  const promptLeak = /язык речи:\s*[a-z-]+\.\s*ниже передана json-строка распознанной речи/iu.test(transcript);
  if (promptLeak || transcript.length < sourceText.trim().length * config.llmNormalizationMinLengthRatio) {
    const error = new Error('The transcript normalization omitted source content or echoed prompt instructions');
    error.code = 'TRANSCRIPT_NORMALIZATION_INCOMPLETE';
    throw error;
  }
  return transcript;
}

async function createSummaryOnce(text, { summaryType, summaryLanguage }, strictQuality = false) {
  const inputChunks = splitAtWordBoundary(text, config.llmMaxInputChars);
  if (inputChunks.length === 1) {
    const note = await summarizeChunk(text, { summaryType, summaryLanguage }, 'transcript', strictQuality);
    note.markdown = renderMarkdown(note);
    return note;
  }

  let notes = [];
  for (const chunk of inputChunks) {
    notes.push(compactNote(await summarizeChunk(chunk, { summaryType, summaryLanguage }, 'transcript', strictQuality)));
  }

  for (let level = 0; level < 6; level += 1) {
    const serialized = JSON.stringify(notes);
    if (serialized.length <= config.llmMaxInputChars) {
      const finalNote = await summarizeChunk(serialized, { summaryType, summaryLanguage }, 'merge', strictQuality);
      finalNote.markdown = renderMarkdown(finalNote);
      return finalNote;
    }
    const noteChunks = splitAtWordBoundary(serialized, config.llmMaxInputChars);
    notes = [];
    for (const chunk of noteChunks) {
      notes.push(compactNote(await summarizeChunk(chunk, { summaryType, summaryLanguage }, 'reduce', strictQuality)));
    }
  }
  throw new Error('Unable to reduce the transcript to the configured LLM context limit');
}

function expectedScriptRatio(note, summaryLanguage) {
  const scriptByLanguage = {
    ru: /\p{Script=Cyrillic}/gu,
    uk: /\p{Script=Cyrillic}/gu,
    bg: /\p{Script=Cyrillic}/gu,
    sr: /\p{Script=Cyrillic}/gu,
    el: /\p{Script=Greek}/gu,
    ar: /\p{Script=Arabic}/gu,
    fa: /\p{Script=Arabic}/gu,
    he: /\p{Script=Hebrew}/gu,
    zh: /\p{Script=Han}/gu,
    ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    ko: /[\p{Script=Hangul}\p{Script=Han}]/gu,
  };
  const expectedScript = scriptByLanguage[summaryLanguage.toLowerCase().split(/[-_]/u)[0]];
  if (!expectedScript) {
    return null;
  }
  const output = [note.title, note.summary, ...note.sections.flatMap((section) => [section.heading, section.content]), ...note.key_points].join(' ');
  const letters = output.match(/[\p{L}]/gu) ?? [];
  if (letters.length < 100) {
    return null;
  }
  const expected = output.match(expectedScript) ?? [];
  return expected.length / letters.length;
}

export function summaryQualityProblems(note, summaryType, summaryLanguage) {
  const problems = [];
  const minimumSections = summaryType === 'detailed' ? 3 : summaryType === 'brief' ? 1 : 0;
  const minimumPoints = summaryType === 'bullet_points' ? 4 : 3;
  if (note.sections.filter((section) => section.heading && section.content).length < minimumSections) {
    problems.push('too_few_sections');
  }
  if (note.key_points.length < minimumPoints) {
    problems.push('too_few_key_points');
  }
  const scriptRatio = expectedScriptRatio(note, summaryLanguage);
  if (scriptRatio !== null && scriptRatio < 0.78) {
    problems.push('wrong_or_mixed_language');
  }
  if (summaryLanguage.toLowerCase().startsWith('ru')) {
    const output = [note.title, note.summary, ...note.sections.flatMap((section) => [section.heading, section.content]), ...note.key_points].join(' ');
    const foreignWords = output.match(/\p{Script=Latin}{3,}/gu) ?? [];
    const foreignIdeographs = output.match(/[\p{Script=Han}\p{Script=Hangul}]/gu) ?? [];
    if (foreignWords.length > 0 || foreignIdeographs.length > 0) {
      problems.push('foreign_words_in_russian_summary');
    }
  }
  return problems;
}

export async function createSummary(text, options) {
  const first = await createSummaryOnce(text, options);
  const problems = summaryQualityProblems(first, options.summaryType, options.summaryLanguage);
  if (problems.length === 0) {
    return first;
  }

  const retried = await createSummaryOnce(text, options, true);
  const remainingProblems = summaryQualityProblems(retried, options.summaryType, options.summaryLanguage);
  if (remainingProblems.length === 0) {
    return retried;
  }

  const error = new Error(`The generated summary did not pass quality checks: ${remainingProblems.join(', ')}`);
  error.code = 'SUMMARY_QUALITY_FAILED';
  throw error;
}

export { splitAtWordBoundary };
