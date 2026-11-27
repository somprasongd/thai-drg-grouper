// Compare this grouper with TGrp6305.exe on generated cases (Windows, or wine; needs the exe).
// The exe is NOT in this repository: unpack S0021.zip from TCMC somewhere and pass its folder.
//
//   node tools/compare.mjs --exe-dir=<folder with TGrp6305.exe> [count=2000] [seed=1] [version=6.3.4]
//                          [--exe=TGrp6305.exe] [--launcher=wine] [--show=20] [--out=diff.json]
//
// Cases are random but realistic: a PDx that is accepted as PDx, secondary diagnoses that carry
// complexity in the PDx's MDC, procedures of the PDx's MDC or any other, ages from newborn to
// old, some broken fields. Both groupers get the same records; the fields DRG, MDC, ERR, WARN,
// RW and ADJRW are compared.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadExeGrouper } from './exe/runner.js';
import { NativeGrouper } from '../src/native/engine.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [count = 2000, seed = 1, version = '6.3.4'] = args.filter((a) => !a.startsWith('--'));
const SHOW = Number(opt.show ?? 20);
if (!opt['exe-dir']) {
    console.error('usage: node tools/compare.mjs --exe-dir=<folder with TGrp6305.exe> [count] [seed] [version]');
    process.exit(2);
}

let s = Number(seed) >>> 0 || 1;
const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const dir = join(ROOT, 'groupers', version);
const g = new NativeGrouper(dir);

const allDx = [...g.dx.keys()];
const pdxCodes = allDx.filter((c) => g.dx.get(c).some((r) => r.accPdx));
const ccCodes = allDx.filter((c) => g.dclText[c] || g.dclText[g.dx.get(c)[0].dclMain]);
const allProc = [...g.proc.keys()].filter((c) => !c.startsWith('C'));
const orProc = allProc.filter((c) => g.proc.get(c).group >= 1);
const procByMdc = {};
for (const [mdc, table] of Object.entries(g.procPdc)) procByMdc[mdc] = Object.keys(table).map((k) => k.replace(/[>*]1$/, '')).filter((k) => g.proc.has(k));
const extProc = allProc.filter((c) => g.proc.get(c).extType);

const fmt = (d) => d.toISOString().slice(0, 10);
const hhmm = () => String(int(0, 23)).padStart(2, '0') + String(int(0, 59)).padStart(2, '0');

function makeCase() {
    const pdx = pick(pdxCodes);
    const row = g.dx.get(pdx)[0];
    const mdc = row.mdc;
    const adm = new Date(Date.UTC(2024, 0, 1) + int(0, 600) * 86400000);
    // age: follow the PDx age range most of the time
    let ageYears;
    const lo = row.ageMin;
    const hi = Math.min(row.ageMax, 100);
    if (chance(0.85)) ageYears = int(lo, hi);
    else ageYears = int(0, 100);
    const neonate = ageYears === 0 && chance(0.4);
    const dob = new Date(adm.getTime() - (ageYears * 365.25 + (neonate ? int(0, 40) : int(0, 360))) * 86400000);
    let losDays = pick([0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 45, 60, 90]);
    const dsc = new Date(adm.getTime() + losDays * 86400000);
    const sexRow = row.sex;
    const rec = {
        DOB: fmt(dob),
        SEX: sexRow === 'M' ? '1' : sexRow === 'F' ? '2' : pick(['1', '2']),
        DATEADM: fmt(adm),
        TIMEADM: hhmm(),
        DATEDSC: fmt(dsc),
        TIMEDSC: hhmm(),
        DISCHT: pick(['1', '1', '1', '2', '3', '4', '4', '5', '8', '9']),
        ADMWT: null,
        AGE: null,
        AGEDAY: null,
        PDX: pdx,
        LEAVEDAY: chance(0.05) ? int(0, 3) : 0,
    };
    const age = (adm - dob) / 86400000;
    if (age < 60 || chance(0.05)) rec.ADMWT = Number((pick([0.25, 0.6, 0.9, 1.2, 1.6, 1.9, 2.2, 2.6, 3.1, 3.6, 4.2])).toFixed(3));
    // secondary diagnoses
    const nSdx = pick([0, 0, 1, 1, 2, 3, 4, 5, 6, 8, 12]);
    for (let i = 1; i <= nSdx; i++) rec[`SDX${i}`] = chance(0.7) ? pick(ccCodes) : pick(allDx);
    // procedures
    const nProc = pick([0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 6]);
    for (let i = 1; i <= nProc; i++) {
        let p;
        const mine = procByMdc[mdc];
        if (mine?.length && chance(0.55)) p = pick(mine);
        else if (chance(0.5)) p = pick(orProc);
        else p = pick(allProc);
        if (g.proc.get(p)?.extType && chance(0.6)) p += '+' + int(1, 3) + int(1, 3);
        rec[`PROC${i}`] = p;
    }
    if (chance(0.03)) rec[`PROC${nProc + 1}`] = pick(extProc) + '+' + int(1, 2) + int(1, 2);
    // broken fields now and then
    if (chance(0.02)) rec.SEX = null;
    if (chance(0.02)) rec.DISCHT = null;
    if (chance(0.01)) rec.TIMEADM = null;
    if (chance(0.01)) rec.PDX = pick(['', 'ZZZZ', 'V010', 'R69']);
    if (chance(0.02)) rec.SDX1 = pdx;
    if (chance(0.01)) rec.PROC1 = '9999';
    if (chance(0.03)) { rec.DOB = null; rec.AGE = String(ageYears); rec.AGEDAY = String(int(0, 364)); }
    return rec;
}

const records = Array.from({ length: Number(count) }, makeCase);
const work = mkdtempSync(join(tmpdir(), 'drg-compare-'));
const runner = loadExeGrouper({ exeDir: resolve(opt['exe-dir']), exe: opt.exe, version, workDir: work, launcher: opt.launcher ?? '' });
const exeOut = [];
try {
    for (let i = 0; i < records.length; i += 5000) exeOut.push(...(await runner.group(version, records.slice(i, i + 5000))));
} finally {
    rmSync(work, { recursive: true, force: true });
}

const FIELDS = ['DRG', 'MDC', 'ERR', 'WARN', 'RW', 'ADJRW'];
const diffs = [];
const byField = Object.fromEntries(FIELDS.map((f) => [f, 0]));
let same = 0;
for (let i = 0; i < records.length; i++) {
    const n = g.group(records[i]);
    const e = exeOut[i];
    const bad = FIELDS.filter((f) => {
        const a = n[f];
        const b = e[f];
        if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a ?? 0) - Number(b ?? 0)) > 0.00005;
        return String(a ?? '').trim() !== String(b ?? '').trim();
    });
    if (!bad.length) { same++; continue; }
    for (const f of bad) byField[f]++;
    const input = Object.fromEntries(Object.entries(records[i]).filter(([, v]) => v !== null && v !== ''));
    diffs.push({ i, bad, input, exe: Object.fromEntries(FIELDS.map((f) => [f, e[f]])), native: n });
}
console.log(`cases ${records.length}  same ${same} (${((100 * same) / records.length).toFixed(2)}%)  different ${diffs.length}`);
console.log('different by field', JSON.stringify(byField));
for (const d of diffs.slice(0, SHOW)) {
    console.log(`#${d.i} [${d.bad.join(',')}] exe ${JSON.stringify(d.exe)}\n   native ${JSON.stringify(d.native)}\n   in ${JSON.stringify(d.input)}`);
}
if (opt.out) writeFileSync(opt.out, JSON.stringify(diffs, null, 1));
