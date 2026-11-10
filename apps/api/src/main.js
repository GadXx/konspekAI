import { buildApp } from './app.js';
import { config } from '../../../packages/config/src/config.js';

let app;
try {
  app = await buildApp();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (app) {app.log.error(error);}
  else {console.error(JSON.stringify({ level: 'fatal', message: 'API startup failed', error: error.message }));}
  process.exitCode = 1;
}

if (app) {
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (closing) {return;}
      closing = true;
      app.close().catch((error) => {
        app.log.error(error, 'API shutdown failed');
        process.exitCode = 1;
      });
    });
  }
}
