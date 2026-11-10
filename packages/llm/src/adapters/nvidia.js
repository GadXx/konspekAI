import { config } from '../../../config/src/config.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible.js';

export function createNvidiaAdapter() {
  return createOpenAiCompatibleAdapter({
    baseURL: config.nvidiaBaseUrl,
    apiKey: config.nvidiaApiKey,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
    modelFor: (stage) => stage === 'normalization'
      ? config.normalizationModel || config.nvidiaModel
      : config.summaryModel || config.nvidiaModel,
    reasoningEffort: config.nvidiaReasoningEffort,
    // NVIDIA's documented Mistral endpoint does not list response_format; prompts request JSON.
    jsonMode: false,
  });
}
