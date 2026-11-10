import { buildApp } from './app.js';
import { config } from '../../../packages/config/src/config.js';

const app = await buildApp();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
