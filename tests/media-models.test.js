import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVoskLanguages, isVoskModelAvailable } from '../packages/media/src/models.js';
import { mediaDemuxerForPath } from '../packages/media/src/inspect.js';

test('доступными считаются языки с настроенной и установленной моделью Vosk', () => {
  assert.deepEqual(availableVoskLanguages(), ['ru']);
  assert.equal(isVoskModelAvailable('.data/test-vosk-model'), true);
  assert.equal(isVoskModelAvailable('.data/missing-vosk-model'), false);
});

test('для поддерживаемых расширений выбирается фиксированный демультиплексор FFmpeg', () => {
  assert.equal(mediaDemuxerForPath('/uploads/lecture.mp4'), 'mov');
  assert.equal(mediaDemuxerForPath('/uploads/voice.wav'), 'wav');
  assert.equal(mediaDemuxerForPath('/uploads/playlist.mp4.m3u8'), undefined);
});
