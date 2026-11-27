import { loadConfig } from './config.js';
import { loadGroupers } from './groupers.js';
import { buildApp } from './app.js';

const config = loadConfig();
const groupers = loadGroupers(config);
const app = await buildApp(config, groupers);

const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(
    { groupers: [...groupers.versions.keys()], default: config.defaultVersion, apiKey: Boolean(config.apiKey) },
    `Thai DRG grouper API ready, docs at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/docs`,
);
