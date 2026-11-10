import OpenAI from 'openai';

export function createOpenAiCompatibleAdapter({ baseURL, apiKey, timeoutMs, maxRetries, modelFor, reasoningEffort, jsonMode = true, client: injectedClient }) {
  const client = injectedClient ?? new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries });

  return {
    configured: Boolean(apiKey && modelFor('summary')),
    async completeJson({ stage, messages, maxTokens }) {
      const request = {
        model: modelFor(stage),
        messages,
        max_tokens: maxTokens,
        stream: false,
      };
      if (jsonMode) {
        request.response_format = { type: 'json_object' };
      }
      if (reasoningEffort && reasoningEffort !== 'none') {
        request.reasoning_effort = reasoningEffort;
      }
      const result = await client.chat.completions.create(request);
      return result.choices[0]?.message?.content ?? '';
    },
    async checkConnection() {
      await client.models.list();
    },
  };
}
