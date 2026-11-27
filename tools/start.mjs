// Start of the Docker image: make the TCMC data on the first start, then run the API.
//
//   node tools/start.mjs
//
// The published image holds no TCMC files. On the first start this runs tools/setup.mjs,
// which downloads the three TCMC zips (or takes them from TCMC_CACHE), checks them and
// writes the tables and rules.json to GROUPERS_DIR. Both folders are on the /data volume,
// so later starts find the files and go straight to the API. Setup runs again when a newer
// image expects another rules.json.
//
//   GROUPERS_DIR  where the grouper files are written and read     (image: /data/groupers)
//   TCMC_CACHE    where the TCMC zips are kept                     (image: /data/cache)
//   SETUP_ARGS    options for tools/setup.mjs                      (default: --strict)

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, loadConfig } from '../src/config.js';
import { missingFiles } from '../src/groupers.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const cache = resolve(ROOT_DIR, process.env.TCMC_CACHE?.trim() || 'cache');
const setupArgs = (process.env.SETUP_ARGS ?? '--strict').split(/\s+/).filter(Boolean);
const repoGroupers = join(ROOT_DIR, 'groupers');
// the rules.json that setup.mjs checks with --strict
const rulesSha = /const RULES_SHA256 = '([0-9a-f]{64})'/.exec(readFileSync(join(here, 'setup.mjs'), 'utf8'))?.[1];

const problems = [];
for (const v of readdirSync(repoGroupers)) {
    const src = join(repoGroupers, v);
    if (!existsSync(join(src, 'grouper.json'))) continue;
    const dir = join(config.groupersDir, v);
    if (dir !== src) {
        // the files kept in git always come from this image
        mkdirSync(join(dir, 'native'), { recursive: true });
        for (const f of ['grouper.json', join('native', 'flow.json')]) copyFileSync(join(src, f), join(dir, f));
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'grouper.json'), 'utf8'));
    const missing = missingFiles(dir, manifest);
    if (missing.length) {
        problems.push(`${v}: ${[...new Set(missing)].join(', ')} not found`);
    } else if (setupArgs.includes('--strict') && rulesSha
        && createHash('sha256').update(readFileSync(join(dir, 'native', 'rules.json'))).digest('hex') !== rulesSha) {
        problems.push(`${v}: rules.json is from another build`);
    }
}

if (problems.length) {
    console.log(`grouper files in ${config.groupersDir}: ${problems.join('; ')}. Running setup.`);
    const r = spawnSync(process.execPath, [join(here, 'setup.mjs'), `--out=${config.groupersDir}`, `--cache=${cache}`, ...setupArgs],
        { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

await import('../src/server.js');
