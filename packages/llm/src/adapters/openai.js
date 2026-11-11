import { config } from '../../../config/src/config.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible.js';

export function createOpenAiAdapter() {
  return createOpenAiCompatibleAdapter({
    baseURL: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
    temperature: config.llmTemperature,
    modelFor: (stage) => stage === 'normalization'
      ? config.normalizationModel || config.openaiModel
      : config.summaryModel || config.openaiModel,
  });
}
