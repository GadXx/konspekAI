import OpenAI from 'openai';

export function createOpenAiCompatibleAdapter({ baseURL, apiKey, timeoutMs, maxRetries, modelFor, reasoningEffort, extraBodyFor, sendReasoningEffort = false, jsonMode = true, temperature = 0.2, client: injectedClient }) {
  const client = injectedClient ?? new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries });

  return {
    configured: Boolean(apiKey && modelFor('summary')),
    async completeJson({ stage, messages, maxTokens }) {
      const request = {
        model: modelFor(stage),
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      };
      if (jsonMode) {
        request.response_format = { type: 'json_object' };
      }
      const effort = typeof reasoningEffort === 'function' ? reasoningEffort(stage) : reasoningEffort;
      if (effort && (sendReasoningEffort || effort !== 'none')) {
        request.reasoning_effort = effort;
      }
      const extraBody = extraBodyFor?.(stage, maxTokens);
      if (extraBody) {
        Object.assign(request, extraBody);
      }
      const result = await client.chat.completions.create(request);
      const choice = result.choices[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        const error = new Error(choice?.finish_reason === 'length'
          ? 'The model exhausted max_tokens before producing final content'
          : 'The model response did not include final content');
        error.code = 'LLM_EMPTY_RESPONSE';
        throw error;
      }
      return content;
    },
    async checkConnection() {
      await client.models.list();
    },
  };
}
