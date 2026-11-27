// Groups a whole .dbf data file, the one that used to go to TGrp6305.exe, and gives the same
// file back with the result fields filled in. Every other byte stays as it was: other
// columns, Thai text in any code page, deleted records, the header date and the end mark.
// Only the result fields of the records that are not deleted change. When the file has no
// result fields at all (or only some), the missing ones are added at the end of each record.
//
// The input fields are read as the exe reads them, with no clean-up: a value the exe would
// not accept (a code with a dot, a Buddhist-era date) gets the same error or warning here.
//
// Patient data stays in memory: nothing here writes to disk or to the log.

import { DbfFormatError, readDbfHeader } from './dbf.js';
import { DRG_FIELDS, MAX_PROC, MAX_SDX } from './layout.js';

export { DbfFormatError };

const INPUT_FIELDS = [
    'DOB', 'SEX', 'DATEADM', 'TIMEADM', 'DATEDSC', 'TIMEDSC', 'DISCHT', 'ADMWT', 'AGE', 'AGEDAY', 'PDX',
    ...Array.from({ length: MAX_SDX }, (_, i) => `SDX${i + 1}`),
    ...Array.from({ length: MAX_PROC }, (_, i) => `PROC${i + 1}`),
    'LEAVEDAY',
];

/** Result fields in the grouper's layout, in the order they are added. */
export const RESULT_FIELDS = ['ACTLOS', 'DRG', 'MDC', 'ERR', 'WARN', 'RW', 'OT', 'WTLOS', 'ADJRW'].map((name) =>
    DRG_FIELDS.find((f) => f.name === name));

const WRITABLE = new Set(['C', 'N', 'F']);
const CHUNK = 2000;

function readValue(buf, start, f) {
    const s = buf.toString('latin1', start + f.offset, start + f.offset + f.length).replace(/\0+$/, '').trim();
    switch (f.type) {
        case 'D':
            return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
        case 'N':
        case 'F': {
            if (s === '' || /^\*+$/.test(s)) return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        }
        default:
            return s;
    }
}

/** The text for one result value in a field of the file. Too wide: '*' (dBase does the same). */
function formatResult(f, value) {
    if (value === null || value === undefined || value === '') return { text: ' '.repeat(f.length), overflow: false };
    let s;
    if (f.type === 'C') {
        s = String(value);
        if (s.length > f.length) return { text: '*'.repeat(f.length), overflow: true };
        return { text: s.padEnd(f.length, ' '), overflow: false };
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return { text: ' '.repeat(f.length), overflow: false };
    s = n.toFixed(f.decimals || 0);
    if (s.length > f.length) return { text: '*'.repeat(f.length), overflow: true };
    return { text: s.padStart(f.length, ' '), overflow: false };
}

/**
 * Add the result fields the file does not have. Returns a new buffer with the new header,
 * each record followed by blanks for the new fields; the old bytes are copied unchanged.
 */
function addFields(buf, header, missing) {
    const { headerLength, recordLength, count, terminator } = header;
    const extraHeader = missing.length * 32;
    const extraRecord = missing.reduce((sum, f) => sum + f.length, 0);
    const newHeaderLength = headerLength + extraHeader;
    const newRecordLength = recordLength + extraRecord;
    if (newHeaderLength > 0xffff || newRecordLength > 0xffff) throw new DbfFormatError('the file has too many fields to add the result fields');
    const tail = buf.subarray(headerLength + count * recordLength); // end mark, if any
    const out = Buffer.alloc(newHeaderLength + count * newRecordLength + tail.length, 0x20);

    buf.copy(out, 0, 0, terminator); // header and the old field descriptors
    out.fill(0, terminator, terminator + extraHeader);
    let offset = recordLength;
    missing.forEach((f, i) => {
        const d = terminator + i * 32;
        out.write(f.name, d, 'latin1');
        out.write(f.type, d + 11, 'latin1');
        // Visual FoxPro keeps the offset of the field in the record here; dBase III ignores it
        if (out[0] === 0x30 || out[0] === 0x31 || out[0] === 0x32) out.writeUInt32LE(offset, d + 12);
        out.writeUInt8(f.length, d + 16);
        out.writeUInt8(f.decimals || 0, d + 17);
        offset += f.length;
    });
    buf.copy(out, terminator + extraHeader, terminator, headerLength); // 0x0D and what follows it (VFP backlink)
    out.writeUInt16LE(newHeaderLength, 8);
    out.writeUInt16LE(newRecordLength, 10);
    for (let r = 0; r < count; r++) {
        buf.copy(out, newHeaderLength + r * newRecordLength, headerLength + r * recordLength, headerLength + (r + 1) * recordLength);
    }
    tail.copy(out, newHeaderLength + count * newRecordLength);
    return out;
}

/**
 * @param {Buffer} input the uploaded .dbf
 * @param {(records: object[]) => Promise<object[]>} group groups records in the grouper's layout
 * @param {{ maxRecords?: number }} [options]
 * @returns {Promise<{ file: Buffer, summary: object }>}
 */
export async function groupDbf(input, group, { maxRecords = Infinity } = {}) {
    let header = readDbfHeader(input);
    if (header.count > maxRecords) {
        throw new DbfFormatError(`the file has ${header.count} records, at most ${maxRecords} are allowed in one file`);
    }
    const byName = new Map(header.fields.map((f) => [f.name.toUpperCase(), f]));
    if (!byName.has('PDX')) throw new DbfFormatError('the file has no PDX field: it is not a grouper data file');

    for (const name of RESULT_FIELDS.map((f) => f.name)) {
        const f = byName.get(name);
        if (f && !WRITABLE.has(f.type)) throw new DbfFormatError(`field ${name} has type ${f.type}; the result needs type C or N`);
    }
    const missing = RESULT_FIELDS.filter((f) => !byName.has(f.name));
    // a copy: the caller's buffer is never changed
    const file = missing.length ? addFields(input, header, missing) : Buffer.from(input);
    if (missing.length) {
        header = readDbfHeader(file);
        byName.clear();
        for (const f of header.fields) byName.set(f.name.toUpperCase(), f);
    }

    const inputs = INPUT_FIELDS.map((name) => [name, byName.get(name)]).filter(([, f]) => f);
    const outputs = RESULT_FIELDS.map((r) => byName.get(r.name));
    const { count, headerLength, recordLength } = header;

    const summary = {
        records: count,
        grouped: 0,
        deleted: 0,
        withError: 0,
        withWarning: 0,
        errors: {},
        overflow: 0,
        sumAdjRw: 0,
        addedFields: missing.map((f) => f.name),
    };

    const live = [];
    for (let r = 0; r < count; r++) {
        if (file[headerLength + r * recordLength] === 0x2a) summary.deleted++;
        else live.push(r);
    }

    for (let i = 0; i < live.length; i += CHUNK) {
        const rows = live.slice(i, i + CHUNK);
        const records = rows.map((r) => {
            const start = headerLength + r * recordLength;
            const rec = {};
            for (const [name, f] of inputs) rec[name] = readValue(file, start, f);
            return rec;
        });
        const results = await group(records);
        rows.forEach((r, k) => {
            const out = results[k];
            const start = headerLength + r * recordLength;
            for (const f of outputs) {
                const { text, overflow } = formatResult(f, out[f.name.toUpperCase()]);
                if (overflow) summary.overflow++;
                file.write(text, start + f.offset, f.length, 'latin1');
            }
            summary.grouped++;
            if (out.ERR) {
                summary.withError++;
                summary.errors[out.ERR] = (summary.errors[out.ERR] ?? 0) + 1;
            }
            if (out.WARN) summary.withWarning++;
            if (Number.isFinite(out.ADJRW)) summary.sumAdjRw += out.ADJRW;
        });
    }
    summary.sumAdjRw = Math.round(summary.sumAdjRw * 10000) / 10000;
    summary.cmi = summary.grouped ? Math.round((summary.sumAdjRw / summary.grouped) * 10000) / 10000 : null;
    return { file, summary };
}
