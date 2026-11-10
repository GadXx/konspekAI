import { resolve } from 'node:path';
import { config } from '../../config/src/config.js';

export function isPathInUploadDirectory(path) {
  const root = resolve(config.uploadDirectory);
  const target = resolve(path);
  return target.startsWith(`${root}/`);
}
