// Loads every grouper version under GROUPERS_DIR and gives the app one object to call.
//
// A version folder (groupers/<version>/) holds:
//   grouper.json        name of the version and its DRG table           (in the repository)
//   native/flow.json    order of the DCs in every MDC, from the books   (in the repository)
//   native/rules.json   rules read from the TCMC books                  (built by npm run setup)
//   c63*.dbf            TCMC tables shipped with the grouper            (fetched by npm run setup)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readDbfFile } from './dbf.js';
import { NativeGrouper } from './native/engine.js';

export class BusyError extends Error {}
export class GrouperError extends Error {}

const SETUP_HINT = 'run "npm run setup" first (it downloads the TCMC files and builds the rules)';

/** The DRG table of a version (c63drg.dbf): DRG -> name, MDC, RW, RW0d, WtLOS, OT. */
export function readDrgTable(path) {
    const table = new Map();
    for (const r of readDbfFile(path).records) {
        if (!r.DRG) continue;
        table.set(r.DRG, {
            drg: r.DRG,
            name: r.DRGNAME ?? '',
            mdc: r.MDC ?? '',
            rw: r.RW ?? null,
            rw0d: r.RW0D ?? null,
            wtlos: r.WTLOS ?? null,
            ot: r.OT ?? null,
        });
    }
    return table;
}

/** Files that npm run setup has to make before a version can be loaded. */
export function missingFiles(dir, manifest) {
    const need = ['native/rules.json', 'native/flow.json', ...(manifest.tables ?? []), manifest.drgTable].filter(Boolean);
    return need.filter((f) => !existsSync(join(dir, f)));
}

/** One version grouped in this process by the native engine. */
export class NativeVersion {
    constructor({ version, sourceDir, manifest }) {
        this.version = version;
        this.engine = 'native';
        this.name = manifest.name ?? `Thai DRG ${version}`;
        this.grouper = new NativeGrouper(sourceDir);
        this.drgTable = manifest.drgTable ? readDrgTable(join(sourceDir, manifest.drgTable)) : new Map();
        this.stats = { runs: 0, cases: 0, failures: 0, totalMs: 0 };
    }

    group(records) {
        const t0 = performance.now();
        try {
            const out = records.map((rec) => ({ ...rec, ...this.grouper.group(rec) }));
            this.stats.runs++;
            this.stats.cases += records.length;
            return out;
        } catch (e) {
            this.stats.failures++;
            throw new GrouperError(`grouper ${this.version} failed: ${e.message}`, { cause: e });
        } finally {
            this.stats.totalMs += performance.now() - t0;
        }
    }
}

/** All loaded versions; limits how many requests may wait at the same time. */
export class GrouperSet {
    constructor({ versions, maxQueue }) {
        this.versions = versions; // Map<string, NativeVersion>
        this.maxQueue = maxQueue;
        this.busy = 0;
    }

    get queued() {
        return this.busy;
    }

    async group(version, records) {
        const v = this.versions.get(version);
        if (!v) throw new GrouperError(`version ${version} is not loaded`);
        if (this.busy >= Math.max(1, this.maxQueue)) throw new BusyError('the grouper is busy, try again later');
        this.busy++;
        try {
            // let other requests in between big batches
            await new Promise((r) => setImmediate(r));
            return v.group(records);
        } finally {
            this.busy--;
        }
    }
}

/** Load every groupers/<version>/ that has a grouper.json. */
export function loadGroupers(config) {
    if (!existsSync(config.groupersDir)) throw new Error(`GROUPERS_DIR ${config.groupersDir} does not exist`);
    const versions = new Map();
    for (const version of readdirSync(config.groupersDir)) {
        const sourceDir = join(config.groupersDir, version);
        const manifestPath = join(sourceDir, 'grouper.json');
        if (!statSync(sourceDir).isDirectory() || !existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const missing = missingFiles(sourceDir, manifest);
        if (missing.length) {
            throw new Error(`grouper ${version}: ${missing.join(', ')} not found in ${sourceDir}; ${SETUP_HINT}`);
        }
        versions.set(version, new NativeVersion({ version, sourceDir, manifest }));
    }
    if (versions.size === 0) throw new Error(`no grouper found in ${config.groupersDir}`);
    if (!versions.has(config.defaultVersion)) {
        throw new Error(`DEFAULT_VERSION ${config.defaultVersion} is not one of: ${[...versions.keys()].join(', ')}`);
    }
    const sorted = new Map([...versions].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
    return new GrouperSet({ versions: sorted, maxQueue: config.maxQueue });
}
