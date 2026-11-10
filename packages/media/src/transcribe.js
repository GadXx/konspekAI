import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import koffi from 'koffi';
import { config } from '../../config/src/config.js';
import { isVoskModelAvailable } from './models.js';

const models = new Map();
let voskApi;

function api() {
  if (voskApi) {
    return voskApi;
  }
  const library = koffi.load(config.voskLibraryPath);
  voskApi = {
    setLogLevel: library.func('void vosk_set_log_level(int level)'),
    modelNew: library.func('void * vosk_model_new(const char *path)'),
    modelFree: library.func('void vosk_model_free(void *model)'),
    recognizerNew: library.func('void * vosk_recognizer_new(void *model, float sampleRate)'),
    recognizerFree: library.func('void vosk_recognizer_free(void *recognizer)'),
    acceptWaveform: library.func('int vosk_recognizer_accept_waveform(void *recognizer, const char *data, int length)'),
    recognizerResult: library.func('const char * vosk_recognizer_result(void *recognizer)'),
    finalResult: library.func('const char * vosk_recognizer_final_result(void *recognizer)'),
  };
  voskApi.setLogLevel(-1);
  return voskApi;
}

function getModel(language) {
  const modelPath = config.voskModels[language];
  if (!modelPath) {
    const error = new Error(`No Vosk model is configured for language "${language}"`);
    error.code = 'UNSUPPORTED_LANGUAGE';
    throw error;
  }
  if (!existsSync(modelPath) || !isVoskModelAvailable(modelPath)) {
    const error = new Error(`Vosk model for language "${language}" was not found at ${modelPath}`);
    error.code = 'ASR_MODEL_UNAVAILABLE';
    throw error;
  }
  if (!models.has(language)) {
    const model = api().modelNew(modelPath);
    if (!model) {
      throw new Error(`Vosk could not load the model for language "${language}"`);
    }
    models.set(language, model);
  }
  return models.get(language);
}

export function transcribeMedia(filePath, language) {
  const vosk = api();
  const model = getModel(language);
  const recognizer = vosk.recognizerNew(model, config.asrSampleRate);
  if (!recognizer) {
    return Promise.reject(new Error(`Vosk could not create a recognizer for language "${language}"`));
  }
  const args = ['-nostdin', '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', String(config.asrSampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const segments = [];
    let settled = false;
    const finish = (error, transcript) => {
      if (!settled) {
        settled = true;
        vosk.recognizerFree(recognizer);
        if (error) {
          reject(error);
        } else {
          resolve(transcript);
        }
      }
    };
    ffmpeg.stdout.on('data', (chunk) => {
      try {
        const accepted = vosk.acceptWaveform(recognizer, chunk, chunk.length);
        if (accepted < 0) {
          throw new Error('Vosk failed while decoding an audio frame');
        }
        if (accepted === 1) {
          const result = JSON.parse(vosk.recognizerResult(recognizer));
          if (result.text?.trim()) {
            segments.push(result.text.trim());
          }
        }
      } catch (error) {
        ffmpeg.kill('SIGKILL');
        finish(error);
      }
    });
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 2048); });
    ffmpeg.on('error', (error) => finish(new Error(`Could not start ffmpeg: ${error.message}`)));
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || 'media decoding failed'}`));
        return;
      }
      try {
        const finalResult = JSON.parse(vosk.finalResult(recognizer));
        if (finalResult.text?.trim()) {
          segments.push(finalResult.text.trim());
        }
        if (segments.length === 0) {
          finish(new Error('No speech was detected in the uploaded media'));
          return;
        }
        finish(undefined, segments.join(' '));
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function disposeModels() {
  if (voskApi) {
    for (const model of models.values()) {
      voskApi.modelFree(model);
    }
  }
  models.clear();
}
