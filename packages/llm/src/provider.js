import OpenAI from 'openai';
import { Ollama } from 'ollama';
import { config } from '../../config/src/config.js';

const ollama = new Ollama({ host: config.ollamaBaseUrl, requestOptions: { timeout: config.llmTimeoutMs } });
const openai = config.llmProvider === 'openai-compatible'
  ? new OpenAI({ baseURL: config.openaiBaseUrl, apiKey: config.openaiApiKey, timeout: config.llmTimeoutMs, maxRetries: 0 })
  : undefined;

export function providerHealth() {
  return { provider: config.llmProvider, configured: config.llmProvider === 'ollama' || Boolean(openai) };
}

function modelFor(stage) {
  if (stage === 'normalization') {
    return config.normalizationModel || (config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel);
  }
  return config.summaryModel || (config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel);
}

function parseJsonResponse(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error('LLM did not return valid JSON');
  }
}

export async function completeJson({ stage, messages, schema, maxTokens = config.llmMaxOutputTokens }) {
  const model = modelFor(stage);
  let content;
  if (config.llmProvider === 'ollama') {
    const result = await ollama.chat({
      model,
      messages,
      stream: false,
      format: schema,
      options: { num_predict: maxTokens },
    });
    content = result.message.content;
  } else {
    const result = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    });
    content = result.choices[0]?.message?.content ?? '';
  }
  return parseJsonResponse(content);
}

export async function checkLlmConnection() {
  if (config.llmProvider === 'ollama') {
    await ollama.list();
  } else {
    await openai.models.list();
  }
  return true;
}
