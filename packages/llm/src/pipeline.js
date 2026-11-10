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
  const sections = note.sections.map((section) => `## ${section.heading}\n\n${section.content}`).join('\n\n');
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
    .filter((section) => section.heading || section.content);
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

async function summarizeChunk(text, { summaryType, summaryLanguage }, mode = 'transcript') {
  const isTranscript = mode === 'transcript';
  const systemPrompt = isTranscript
    ? renderPrompt(`summary.${summaryType}.system.txt`, { language: summaryLanguage })
    : `${renderPrompt(`summary.${summaryType}.system.txt`, { language: summaryLanguage })}\n\n${renderPrompt(`summary.${mode}.system.txt`, { summary_type: summaryType })}`;
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
  const chunks = splitAtWordBoundary(text, config.llmMaxInputChars);
  const normalized = [];
  for (const chunk of chunks) {
    normalized.push(await normalizeChunk(chunk, language));
  }
  return normalized.join('\n\n');
}

export async function createSummary(text, { summaryType, summaryLanguage }) {
  const inputChunks = splitAtWordBoundary(text, config.llmMaxInputChars);
  if (inputChunks.length === 1) {
    const note = await summarizeChunk(text, { summaryType, summaryLanguage });
    note.markdown = renderMarkdown(note);
    return note;
  }

  let notes = [];
  for (const chunk of inputChunks) {
    notes.push(compactNote(await summarizeChunk(chunk, { summaryType, summaryLanguage })));
  }

  for (let level = 0; level < 6; level += 1) {
    const serialized = JSON.stringify(notes);
    if (serialized.length <= config.llmMaxInputChars) {
      const finalNote = await summarizeChunk(serialized, { summaryType, summaryLanguage }, 'merge');
      finalNote.markdown = renderMarkdown(finalNote);
      return finalNote;
    }
    const noteChunks = splitAtWordBoundary(serialized, config.llmMaxInputChars);
    notes = [];
    for (const chunk of noteChunks) {
      notes.push(compactNote(await summarizeChunk(chunk, { summaryType, summaryLanguage }, 'reduce')));
    }
  }
  throw new Error('Unable to reduce the transcript to the configured LLM context limit');
}

export { splitAtWordBoundary };
