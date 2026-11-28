// What the .csv, .xlsx and .json file formats share: which column is which, how a row
// becomes a case, and the result columns that are written back.
//
// A row is read like the JSON API reads a case (dots in codes are fine, codes are cut to
// the grouper's lengths), with a few things that files from Thai hospitals often have:
// dates as วว/ดด/ปปปป, years in พ.ศ. (a year after 2400 is taken as พ.ศ.), times as
// 8.30 or 830, and a procedure code that a spreadsheet turned into a number (1.25 → 01.25).
//
// Patient data stays in memory: nothing here writes to disk or to the log.

import { InputError, toGrouperRecord } from './input.js';
import { toResult } from './result.js';

export class FileFormatError extends Error {}

/** How far down a sheet or a .csv the header row (the row with a PDX column) is looked for. */
export const HEADER_SEARCH_ROWS = 20;
const CHUNK = 2000;

export const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_.\-]/g, '');

// API name → header names it is found under (after norm). The grouper's .dbf names come second.
const ALIASES = {
    ref: ['ref'],
    sex: ['sex'],
    dob: ['dob', 'birthdate', 'dateofbirth'],
    admitDate: ['admitdate', 'dateadm'],
    admitTime: ['admittime', 'timeadm'],
    dischargeDate: ['dischargedate', 'datedsc'],
    dischargeTime: ['dischargetime', 'timedsc'],
    dischargeType: ['dischargetype', 'discht'],
    admitWeight: ['admitweight', 'admwt'],
    age: ['age'],
    ageDay: ['ageday'],
    pdx: ['pdx'],
    sdx: ['sdx'],
    procedures: ['procedures', 'procedure', 'proc', 'procs'],
    leaveDays: ['leavedays', 'leaveday'],
};
const BY_ALIAS = new Map(Object.entries(ALIASES).flatMap(([key, names]) => names.map((n) => [n, key])));

/** Result columns written to .csv and .xlsx files, in this order. */
export const RESULT_COLUMNS = ['DRG', 'DRGNAME', 'MDC', 'RW', 'ADJRW', 'WTLOS', 'OT', 'ACTLOS', 'ERR', 'ERRMSG', 'WARN', 'WARNMSG', 'GRPNOTE'];

/** The values of the result columns for one row; null for a row that was not grouped at all. */
export function resultValues(r) {
    if (!r) return null;
    if (!r.ok) return { GRPNOTE: r.inputErrors.join('; ') };
    return {
        DRG: r.drg,
        DRGNAME: r.drgName,
        MDC: r.mdc,
        RW: r.rw,
        ADJRW: r.adjrw,
        WTLOS: r.wtlos,
        OT: r.ot,
        ACTLOS: r.los,
        ERR: r.errorCode,
        ERRMSG: r.error?.message ?? null,
        WARN: r.warningCode,
        WARNMSG: r.warnings.map((w) => w.message).join('; ') || null,
        GRPNOTE: r.notes.join('; ') || null,
    };
}

/** True when the header row has a PDX column (any spelling ALIASES accepts). */
export const isHeaderRow = (cells) => cells.some((c) => BY_ALIAS.get(norm(c)) === 'pdx');

/**
 * Which column holds which input, from the header row.
 * @param {string[]} headers header text by column index
 */
export function mapColumns(headers) {
    const fields = [];
    const sdx = [];
    const procs = [];
    const seen = new Set();
    headers.forEach((h, index) => {
        const n = norm(h);
        if (!n) return;
        let m;
        if ((m = /^sdx(\d{1,2})$/.exec(n))) sdx.push({ n: Number(m[1]), index });
        else if ((m = /^proc(\d{1,2})$/.exec(n))) procs.push({ n: Number(m[1]), index });
        else if (BY_ALIAS.has(n) && !seen.has(BY_ALIAS.get(n))) {
            seen.add(BY_ALIAS.get(n));
            fields.push({ key: BY_ALIAS.get(n), index });
        }
    });
    if (!seen.has('pdx')) throw new FileFormatError('no PDX column: the header row needs a column named PDX');
    sdx.sort((a, b) => a.n - b.n);
    procs.sort((a, b) => a.n - b.n);
    return { fields, sdx: sdx.map((c) => c.index), procs: procs.map((c) => c.index) };
}

/**
 * Where each result column goes: the column with that name when the file has one
 * (it is written over), otherwise a new column from `firstFree` on.
 */
export function placeResults(headers, firstFree) {
    const at = new Map();
    headers.forEach((h, i) => {
        const n = String(h ?? '').trim().toUpperCase();
        if (RESULT_COLUMNS.includes(n) && !at.has(n)) at.set(n, i);
    });
    const added = [];
    let next = firstFree;
    const columns = RESULT_COLUMNS.map((name) => {
        if (at.has(name)) return { name, index: at.get(name), added: false };
        added.push(name);
        return { name, index: next++, added: true };
    });
    return { columns, added };
}

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const beYear = (y) => (y > 2400 ? y - 543 : y);
const p2 = (n) => String(n).padStart(2, '0');

/** วว/ดด/ปปปป [ชช:นน] and years in พ.ศ. → YYYY-MM-DD[THH:mm]; anything else is left for input.js to judge. */
export function normDate(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    const withTime = (date, t) => (t === undefined ? date : `${date}T${normTime(t)}`);
    let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\S+))?$/.exec(s);
    if (m) return withTime(`${beYear(Number(m[3]))}-${p2(m[2])}-${p2(m[1])}`, m[4]);
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\S+))?$/.exec(s);
    if (m) return withTime(`${beYear(Number(m[1]))}-${p2(m[2])}-${p2(m[3])}`, m[4]);
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return `${beYear(Number(m[1]))}-${m[2]}-${m[3]}`;
    return s;
}

/** 830, "830", "8.30", "08:30:00" → "HH:mm"; anything else is left for input.js to judge. */
export function normTime(v) {
    if (blank(v)) return undefined;
    const s = String(v).trim();
    if (/^\d{3,4}$/.test(s)) return `${s.padStart(4, '0').slice(0, 2)}:${s.padStart(4, '0').slice(2)}`;
    const m = /^(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?$/.exec(s);
    return m ? `${p2(m[1])}:${m[2]}` : s;
}

/** A procedure that a spreadsheet stored as a number: 1.25 → "01.25" (ICD-9-CM has two digits before the dot). */
function procCode(v) {
    if (typeof v !== 'number') return v;
    const s = String(v);
    return s.includes('.') ? s.replace(/^(\d)\./, '0$1.') : s;
}

const text = (v) => (typeof v === 'number' ? String(v) : v);

/**
 * One row → a case for toGrouperRecord. `get(index)` gives the cell value: a string,
 * a number, or null/undefined when empty.
 */
export function rowToCase(map, get) {
    const c = {};
    for (const { key, index } of map.fields) {
        let v = get(index);
        if (blank(v)) continue;
        if (key === 'dob' || key === 'admitDate' || key === 'dischargeDate') v = normDate(text(v));
        else if (key === 'admitTime' || key === 'dischargeTime') v = normTime(v);
        else if (key === 'procedures') v = typeof v === 'number' ? [procCode(v)] : v;
        else if (key === 'sdx') v = text(v);
        else if (key !== 'admitWeight' && key !== 'leaveDays') v = text(v);
        if (v !== undefined) c[key] = v;
    }
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/).filter(Boolean) : []);
    if (map.sdx.length) c.sdx = [...list(c.sdx), ...map.sdx.map(get).filter((v) => !blank(v)).map(text)];
    if (map.procs.length) c.procedures = [...list(c.procedures), ...map.procs.map(get).filter((v) => !blank(v)).map((v) => text(procCode(v)))];
    return c;
}

/**
 * Group the rows of a file. `rows[i]` is `(index) => value`, or null for a row to skip
 * (blank). `map` is what mapColumns answers, or a function that turns a row into a case.
 * Answers one result per row, null for skipped rows.
 */
export async function groupRows(map, rows, { group, pool, maxRecords = Infinity }) {
    const live = rows.filter(Boolean).length;
    if (live > maxRecords) throw new FileFormatError(`the file has ${live} rows, at most ${maxRecords} are allowed in one file`);

    const results = new Array(rows.length).fill(null);
    const summary = { records: live, grouped: 0, rejected: 0, skipped: rows.length - live, withError: 0, withWarning: 0, errors: {}, sumAdjRw: 0 };
    let batch = [];
    const run = async () => {
        if (!batch.length) return;
        const out = await group(batch.map((b) => b.record));
        batch.forEach((b, k) => {
            const r = toResult(b.i, b.ref, pool.version, pool, out[k], b.notes);
            delete r.index;
            results[b.i] = r;
            summary.grouped++;
            if (r.errorCode) {
                summary.withError++;
                summary.errors[r.errorCode] = (summary.errors[r.errorCode] ?? 0) + 1;
            }
            if (r.warningCode) summary.withWarning++;
            if (Number.isFinite(r.adjrw)) summary.sumAdjRw += r.adjrw;
        });
        batch = [];
    };
    for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        const c = typeof map === 'function' ? map(rows[i]) : rowToCase(map, rows[i]);
        try {
            const { record, notes } = toGrouperRecord(c);
            batch.push({ i, ref: c.ref, record, notes });
        } catch (e) {
            if (!(e instanceof InputError)) throw e;
            results[i] = { ref: c.ref ?? null, ok: false, version: pool.version, inputErrors: e.problems };
            summary.rejected++;
        }
        if (batch.length >= CHUNK) await run();
    }
    await run();
    summary.sumAdjRw = Math.round(summary.sumAdjRw * 10000) / 10000;
    summary.cmi = summary.grouped ? Math.round((summary.sumAdjRw / summary.grouped) * 10000) / 10000 : null;
    return { results, summary };
}

/** A row with nothing in it is skipped, not counted as a case. */
export const isBlankRow = (values) => values.every(blank);
