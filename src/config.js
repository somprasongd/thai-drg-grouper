import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = resolve(ROOT_DIR, '.env');
if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

function int(name, fallback, min = 0) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < min || String(n) !== raw.trim()) {
        throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
    }
    return n;
}

function str(name, fallback) {
    const raw = process.env[name];
    return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function loadConfig() {
    return {
        host: str('HOST', '127.0.0.1'),
        port: int('PORT', 8089, 1),
        apiKey: str('API_KEY', ''),
        defaultVersion: str('DEFAULT_VERSION', '6.3.4'),
        groupersDir: resolve(ROOT_DIR, str('GROUPERS_DIR', './groupers')),
        maxQueue: int('MAX_QUEUE', 200, 1),
        maxBatch: int('MAX_BATCH', 5000, 1),
        maxFileRecords: int('MAX_FILE_RECORDS', 100000, 1),
        webUi: str('WEB_UI', 'on') !== 'off',
        logLevel: str('LOG_LEVEL', 'info'),
    };
}
