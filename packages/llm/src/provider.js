import { Ollama } from 'ollama';
import { config } from '../../config/src/config.js';
import { createNvidiaAdapter } from './adapters/nvidia.js';
import { createOpenAiAdapter } from './adapters/openai.js';

const ollama = new Ollama({ host: config.ollamaBaseUrl, requestOptions: { timeout: config.llmTimeoutMs } });
const apiAdapter = config.llmProvider === 'nvidia' && config.nvidiaApiKey ? createNvidiaAdapter()
  : config.llmProvider === 'openai-compatible' && config.openaiApiKey ? createOpenAiAdapter()
    : undefined;

export function providerHealth() {
  return { provider: config.llmProvider, configured: config.llmProvider === 'ollama' || Boolean(apiAdapter?.configured) || config.serviceRole === 'api' };
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
  let content;
  if (config.llmProvider === 'ollama') {
    const result = await ollama.chat({
      model: stage === 'normalization'
        ? config.normalizationModel || config.ollamaModel
        : config.summaryModel || config.ollamaModel,
      messages,
      stream: false,
      format: schema,
      options: { num_predict: maxTokens },
    });
    content = result.message.content;
  } else {
    content = await apiAdapter.completeJson({ stage, messages, schema, maxTokens });
  }
  return typeof content === 'string' ? parseJsonResponse(content) : content;
}

export async function checkLlmConnection() {
  if (config.llmProvider === 'ollama') {
    await ollama.list();
  } else {
    await apiAdapter.checkConnection();
  }
  return true;
}
