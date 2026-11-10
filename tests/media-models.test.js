import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVoskLanguages, isVoskModelAvailable } from '../packages/media/src/models.js';
import { mediaDemuxerForPath } from '../packages/media/src/inspect.js';

test('only configured languages with a Vosk model marker are reported as available', () => {
  assert.deepEqual(availableVoskLanguages(), ['ru']);
  assert.equal(isVoskModelAvailable('.data/test-vosk-model'), true);
  assert.equal(isVoskModelAvailable('.data/missing-vosk-model'), false);
});

test('supported media extensions select a fixed FFmpeg demuxer', () => {
  assert.equal(mediaDemuxerForPath('/uploads/lecture.mp4'), 'mov');
  assert.equal(mediaDemuxerForPath('/uploads/voice.wav'), 'wav');
  assert.equal(mediaDemuxerForPath('/uploads/playlist.mp4.m3u8'), undefined);
});
