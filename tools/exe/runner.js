// Development tool only: runs a TCMC grouper exe (TGrp6305.exe) on a data file and reads the
// answer back, so that tools/compare.mjs can check the native engine against it. The exe is not
// part of this repository; pass the folder where you installed it (--exe-dir). The API never uses this.
//
// Facts this file is built on (all checked against the real TGrp6305 / tgrp6205 / tdrg exe):
//  * Usage is "<exe> <data.dbf>". The exe writes DRG, MDC, RW, ADJRW, WTLOS, OT, ERR, WARN and
//    ACTLOS back into the same file and exits with code 0, even for cases with errors.
//  * Only ONE grouper may run at a time on a Windows session, whatever its version or folder:
//    a second copy started while one is running exits at once with code 0 and writes nothing.
//    So all versions share one runner that starts one exe at a time. Requests that wait are
//    merged into one run (one data file with many records), which is how the grouper is fast:
//    3000 cases take about 1.5 s, one case about 0.5 s.
//  * A run that writes nothing is retried, because a grouper started outside this server
//    (for example by the Hospital-OS desktop on the same machine) blocks ours the same way.
//  * It rebuilds its CDX index files in its own folder and they grow on every run, so every
//    run starts by deleting *.CDX (the exe then makes fresh ones).
//  * Visual FoxPro splits arguments on spaces, so the file is passed as a bare name with the
//    version folder as the current directory.

import { spawn, execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readDbfFile, writeDbfFile } from '../../src/dbf.js';
import { DRG_FIELDS } from '../../src/layout.js';

const DATA_FILE = 'input.dbf';
const SKIP_ON_COPY = /\.(cdx|bak|tbk)$|^foxuser\.|^grouper\.json$|^input\.dbf$/i;
const BLOCKED_RETRIES = 5;
const BLOCKED_WAIT_MS = 400;

export class BusyError extends Error {}
export class GrouperError extends Error {}
class BlockedError extends GrouperError {}

function cleanFolder(dir) {
    for (const name of readdirSync(dir)) {
        if (/\.cdx$/i.test(name) || name.toLowerCase() === DATA_FILE) {
            try {
                unlinkSync(join(dir, name));
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
        }
    }
}

function killTree(child) {
    if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
        child.kill('SIGKILL');
    }
}

/** One installed grouper version run by its exe: its private working folder and DRG name table. */
export class GrouperVersion {
    constructor({ version, sourceDir, workDir, manifest }) {
        this.version = version;
        this.engine = 'exe';
        this.name = manifest.name ?? `Thai DRG ${version}`;
        this.exe = manifest.exe;
        this.sourceDir = sourceDir;
        this.dir = join(workDir, version);
        this.stats = { runs: 0, cases: 0, failures: 0, totalMs: 0 };
        if (!this.exe || !existsSync(join(sourceDir, this.exe))) {
            throw new Error(`grouper ${version}: ${this.exe} not found in ${sourceDir}`);
        }
    }

    /** Copy the version folder to WORK_DIR so the original files are never written to. */
    init() {
        rmSync(this.dir, { recursive: true, force: true });
        mkdirSync(this.dir, { recursive: true });
        cpSync(this.sourceDir, this.dir, {
            recursive: true,
            filter: (src) => statSync(src).isDirectory() || !SKIP_ON_COPY.test(basename(src)),
        });
    }
}

/**
 * Starts one grouper exe at a time and merges waiting requests of the same version into one run.
 */
export class GrouperRunner {
    constructor({ versions, maxQueue, maxBatch, timeoutMs, launcher, log }) {
        this.versions = versions; // Map<string, GrouperVersion>
        this.maxQueue = maxQueue;
        this.maxBatch = maxBatch;
        this.timeoutMs = timeoutMs;
        this.launcher = launcher;
        this.log = log;
        this.queue = []; // { version, records, resolve, reject }
        this.running = false;
    }

    get queued() {
        return this.queue.length;
    }

    /**
     * Group records (already in grouper field form). Output order matches input order.
     * @returns {Promise<object[]>} the records as the grouper wrote them back
     */
    group(version, records) {
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new BusyError('the grouper is busy, try again later'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ version, records, resolve, reject });
            this.pump();
        });
    }

    async pump() {
        if (this.running || this.queue.length === 0) return;
        this.running = true;
        try {
            while (this.queue.length) {
                // Take the oldest request, then every later one of the same version while it fits.
                const first = this.queue[0];
                const jobs = [];
                let total = 0;
                this.queue = this.queue.filter((job) => {
                    if (job.version !== first.version) return true;
                    if (jobs.length && total + job.records.length > this.maxBatch) return true;
                    jobs.push(job);
                    total += job.records.length;
                    return false;
                });
                const v = this.versions.get(first.version);
                try {
                    const out = await this.runWithRetry(v, jobs.flatMap((j) => j.records));
                    let at = 0;
                    for (const job of jobs) {
                        job.resolve(out.slice(at, at + job.records.length));
                        at += job.records.length;
                    }
                } catch (e) {
                    for (const job of jobs) job.reject(e);
                }
            }
        } finally {
            this.running = false;
        }
    }

    async runWithRetry(v, records) {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.runOnce(v, records);
            } catch (e) {
                if (!(e instanceof BlockedError) || attempt > BLOCKED_RETRIES) {
                    v.stats.failures += 1;
                    throw e;
                }
                this.log?.warn({ version: v.version, attempt }, 'grouper wrote nothing (another grouper running?), retrying');
                await sleep(BLOCKED_WAIT_MS * attempt);
            }
        }
    }

    async runOnce(v, records) {
        const started = Date.now();
        cleanFolder(v.dir);
        const file = join(v.dir, DATA_FILE);
        writeDbfFile(file, DRG_FIELDS, records);
        await this.spawnExe(v);
        const out = readDbfFile(file).records;
        if (out.length !== records.length) {
            throw new GrouperError(`grouper returned ${out.length} records for ${records.length} cases`);
        }
        const done = out.filter((r) => r.DRG).length;
        if (done === 0) throw new BlockedError('grouper finished without writing any result');
        if (done !== out.length) throw new GrouperError(`grouper wrote a DRG for only ${done} of ${out.length} cases`);
        const ms = Date.now() - started;
        v.stats.runs += 1;
        v.stats.cases += records.length;
        v.stats.totalMs += ms;
        this.log?.debug({ version: v.version, cases: records.length, ms }, 'grouper run');
        return out;
    }

    spawnExe(v) {
        const exePath = join(v.dir, v.exe);
        const [cmd, args] = this.launcher ? [this.launcher, [exePath, DATA_FILE]] : [exePath, [DATA_FILE]];
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, { cwd: v.dir, windowsHide: true, stdio: 'ignore' });
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                killTree(child);
            }, this.timeoutMs);
            child.on('error', (e) => {
                clearTimeout(timer);
                reject(new GrouperError(`cannot start ${v.exe}: ${e.message}`));
            });
            child.on('exit', (code) => {
                clearTimeout(timer);
                if (timedOut) reject(new GrouperError(`${v.exe} did not finish within ${this.timeoutMs} ms and was stopped`));
                else if (code !== 0) reject(new GrouperError(`${v.exe} exited with code ${code}`));
                else resolve();
            });
        });
    }
}

/**
 * One exe grouper from a folder outside the repository (the folder is copied to workDir first,
 * so the original is never written to).
 * @param {{ exeDir: string, exe?: string, version?: string, workDir: string, timeoutMs?: number, launcher?: string }} o
 */
export function loadExeGrouper({ exeDir, exe = 'TGrp6305.exe', version = '6.3.4', workDir, timeoutMs = 600000, launcher = '' }) {
    if (!existsSync(exeDir)) throw new Error(`exe folder ${exeDir} does not exist`);
    const v = new GrouperVersion({ version, sourceDir: exeDir, workDir, manifest: { exe } });
    v.init();
    return new GrouperRunner({ versions: new Map([[version, v]]), maxQueue: 10, maxBatch: 5000, timeoutMs, launcher });
}
