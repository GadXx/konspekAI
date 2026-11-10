import { mkdirSync, writeFileSync } from 'node:fs';

process.env.APP_ENV = 'development';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_DIALECT = 'sqlite';
process.env.SQLITE_PATH = '.data/konspekai-test.sqlite';
process.env.UPLOAD_DIRECTORY = '.data/test-uploads';
process.env.VOSK_MODELS_JSON = '{"ru":".data/test-vosk-model"}';
process.env.LLM_MAX_INPUT_CHARS = '128';
mkdirSync('.data', { recursive: true });
mkdirSync('.data/test-vosk-model/conf', { recursive: true });
writeFileSync('.data/test-vosk-model/conf/model.conf', 'test model marker');
