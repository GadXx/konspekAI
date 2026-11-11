import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCompatibleAdapter } from '../packages/llm/src/adapters/openai-compatible.js';

test('адаптер NVIDIA передаёт параметры рассуждения Nemotron на каждом этапе', async () => {
  const requests = [];
  const adapter = createOpenAiCompatibleAdapter({
    apiKey: 'test-key',
    temperature: 0.2,
    modelFor: (stage) => stage === 'normalization' ? 'nvidia/test-model' : 'nvidia/nemotron-3.5-lightning-30b-a3b',
    extraBodyFor: (stage) => stage === 'normalization'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 4096 },
    jsonMode: true,
    client: {
      chat: { completions: { create: async (payload) => { requests.push(payload); return { choices: [{ message: { content: '{"ok":true}' } }] }; } } },
      models: { list: async () => ({}) },
    },
  });
  const content = await adapter.completeJson({ stage: 'summary', messages: [{ role: 'user', content: 'test' }], maxTokens: 512 });
  await adapter.completeJson({ stage: 'normalization', messages: [{ role: 'user', content: 'test' }], maxTokens: 256 });
  assert.equal(content, '{"ok":true}');
  const request = requests[0];
  assert.equal(request.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(request.max_tokens, 512);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.stream, false);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true });
  assert.equal(request.reasoning_budget, 4096);
  assert.deepEqual(requests[1].chat_template_kwargs, { enable_thinking: false });
  assert.equal('reasoning_budget' in requests[1], false);
});

test('совместимый адаптер сообщает об исчерпании лимита, если провайдер не вернул текст', async () => {
  const adapter = createOpenAiCompatibleAdapter({
    apiKey: 'test-key', modelFor: () => 'test-model', jsonMode: false,
    client: { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'length', message: { content: null } }] }) } }, models: { list: async () => ({}) } },
  });
  await assert.rejects(adapter.completeJson({ stage: 'summary', messages: [], maxTokens: 32 }), { code: 'LLM_EMPTY_RESPONSE', message: /exhausted max_tokens/u });
});
