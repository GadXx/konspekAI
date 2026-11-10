import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/src/config.js';

export function isVoskModelAvailable(modelPath) {
  try {
    return statSync(join(modelPath, 'conf', 'model.conf')).isFile();
  } catch {
    return false;
  }
}

export function availableVoskLanguages() {
  return Object.entries(config.voskModels)
    .filter(([, modelPath]) => existsSync(modelPath) && isVoskModelAvailable(modelPath))
    .map(([language]) => language);
}
