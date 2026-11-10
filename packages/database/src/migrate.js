import { migrate } from './database.js';

await migrate();
console.info('Database schema is ready.');
