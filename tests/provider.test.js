import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCompatibleAdapter } from '../packages/llm/src/adapters/openai-compatible.js';

test('NVIDIA-compatible adapter sends JSON chat completion request with configured reasoning effort', async () => {
  let request;
  const adapter = createOpenAiCompatibleAdapter({
    apiKey: 'test-key',
    modelFor: (stage) => stage === 'normalization' ? 'nvidia/test-model' : 'mistralai/mistral-large-4-1t-a52b',
    reasoningEffort: 'high',
    jsonMode: false,
    client: {
      chat: { completions: { create: async (payload) => { request = payload; return { choices: [{ message: { content: '{"ok":true}' } }] }; } } },
      models: { list: async () => ({}) },
    },
  });
  const content = await adapter.completeJson({ stage: 'summary', messages: [{ role: 'user', content: 'test' }], maxTokens: 512 });
  assert.equal(content, '{"ok":true}');
  assert.equal(request.model, 'mistralai/mistral-large-4-1t-a52b');
  assert.equal(request.max_tokens, 512);
  assert.equal(request.stream, false);
  assert.equal(request.response_format, undefined);
  assert.equal(request.reasoning_effort, 'high');
});
