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
    extraBodyFor: (stage) => {
      const enableThinking = stage === 'normalization'
        ? config.nvidiaNormalizationEnableThinking
        : config.nvidiaEnableThinking;
      return enableThinking
        ? {
            chat_template_kwargs: { enable_thinking: true },
            reasoning_budget: config.nvidiaReasoningBudget,
          }
        : { chat_template_kwargs: { enable_thinking: false } };
    },
    // Nemotron supports JSON response mode in addition to NIM-specific thinking fields.
    jsonMode: true,
  });
}
