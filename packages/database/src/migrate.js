process.env.SERVICE_ROLE ??= 'migrate';
const { migrate } = await import('./database.js');

await migrate();
console.info('Database schema is ready.');
