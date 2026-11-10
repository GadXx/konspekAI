import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVoskLanguages, isVoskModelAvailable } from '../packages/media/src/models.js';

test('only configured languages with a Vosk model marker are reported as available', () => {
  assert.deepEqual(availableVoskLanguages(), ['ru']);
  assert.equal(isVoskModelAvailable('.data/test-vosk-model'), true);
  assert.equal(isVoskModelAvailable('.data/missing-vosk-model'), false);
});
