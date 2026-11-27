// Minimal dBase III (.dbf) reader/writer — enough for the Thai DRG grouper's data file.
// Supports field types C (character), N (numeric), D (date, YYYYMMDD) and L (logical).
// The grouper (Visual FoxPro 9) accepts dBase III files (version byte 0x03), the same
// format the Hospital-OS module has always written.

import { readFileSync, writeFileSync } from 'node:fs';

const HEADER_SIZE = 32;
const FIELD_DESC_SIZE = 32;

/**
 * @typedef {{ name: string, type: 'C'|'N'|'D'|'L', length: number, decimals?: number }} DbfField
 */

function formatValue(field, value) {
    const { type, length, decimals = 0 } = field;
    if (value === null || value === undefined || value === '') {
        return ' '.repeat(length);
    }
    switch (type) {
        case 'C': {
            const s = String(value);
            if (/[^\x20-\x7e]/.test(s)) {
                throw new Error(`field ${field.name}: only printable ASCII is allowed`);
            }
            if (s.length > length) {
                throw new Error(`field ${field.name}: "${s}" is longer than ${length} characters`);
            }
            return s.padEnd(length, ' ');
        }
        case 'N': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                throw new Error(`field ${field.name}: "${value}" is not a number`);
            }
            const s = n.toFixed(decimals);
            if (s.length > length) {
                throw new Error(`field ${field.name}: ${s} does not fit N(${length},${decimals})`);
            }
            return s.padStart(length, ' ');
        }
        case 'D': {
            // Accept Date objects or "YYYY-MM-DD" / "YYYYMMDD" strings.
            let s;
            if (value instanceof Date) {
                s = value.toISOString().slice(0, 10).replace(/-/g, '');
            } else {
                s = String(value).replace(/-/g, '');
            }
            if (!/^\d{8}$/.test(s)) {
                throw new Error(`field ${field.name}: "${value}" is not a date`);
            }
            return s;
        }
        case 'L':
            return value ? 'T' : 'F';
        default:
            throw new Error(`field ${field.name}: unsupported type ${type}`);
    }
}

/**
 * Build a dBase III file in memory.
 * @param {DbfField[]} fields
 * @param {Array<Record<string, unknown>>} records keyed by field name (case-insensitive)
 * @returns {Buffer}
 */
export function buildDbf(fields, records) {
    const recordLength = 1 + fields.reduce((sum, f) => sum + f.length, 0);
    const headerLength = HEADER_SIZE + fields.length * FIELD_DESC_SIZE + 1;
    const buf = Buffer.alloc(headerLength + records.length * recordLength + 1, 0);

    const now = new Date();
    buf.writeUInt8(0x03, 0);
    buf.writeUInt8(now.getFullYear() - 1900, 1);
    buf.writeUInt8(now.getMonth() + 1, 2);
    buf.writeUInt8(now.getDate(), 3);
    buf.writeUInt32LE(records.length, 4);
    buf.writeUInt16LE(headerLength, 8);
    buf.writeUInt16LE(recordLength, 10);

    fields.forEach((f, i) => {
        const off = HEADER_SIZE + i * FIELD_DESC_SIZE;
        if (f.name.length > 10) {
            throw new Error(`field name ${f.name} is longer than 10 characters`);
        }
        buf.write(f.name.toUpperCase(), off, 'ascii');
        buf.write(f.type, off + 11, 'ascii');
        buf.writeUInt8(f.length, off + 16);
        buf.writeUInt8(f.decimals || 0, off + 17);
    });
    buf.writeUInt8(0x0d, headerLength - 1);

    records.forEach((rec, r) => {
        const upper = {};
        for (const [k, v] of Object.entries(rec)) upper[k.toUpperCase()] = v;
        let off = headerLength + r * recordLength;
        buf.write(' ', off++, 'ascii'); // not deleted
        for (const f of fields) {
            buf.write(formatValue(f, upper[f.name.toUpperCase()]), off, 'ascii');
            off += f.length;
        }
    });
    buf.writeUInt8(0x1a, buf.length - 1);
    return buf;
}

/**
 * Parse a dBase III / FoxPro .dbf buffer.
 * @param {Buffer} buf
 * @returns {{ fields: DbfField[], records: Array<Record<string, string|number|null>> }}
 */
export function parseDbf(buf) {
    const version = buf.readUInt8(0);
    const count = buf.readUInt32LE(4);
    const headerLength = buf.readUInt16LE(8);
    const recordLength = buf.readUInt16LE(10);

    const fields = [];
    for (let off = HEADER_SIZE; off + FIELD_DESC_SIZE <= headerLength && buf[off] !== 0x0d; off += FIELD_DESC_SIZE) {
        const rawName = buf.toString('ascii', off, off + 11);
        fields.push({
            name: rawName.replace(/\0.*$/s, '').trim(),
            type: String.fromCharCode(buf[off + 11]),
            length: buf[off + 16],
            decimals: buf[off + 17],
        });
    }

    const records = [];
    for (let r = 0; r < count; r++) {
        let off = headerLength + r * recordLength;
        if (off + recordLength > buf.length) break;
        const deleted = buf[off] === 0x2a; // '*'
        off += 1;
        const rec = {};
        for (const f of fields) {
            const raw = buf.toString('latin1', off, off + f.length);
            off += f.length;
            rec[f.name.toUpperCase()] = parseValue(f, raw);
        }
        if (!deleted) records.push(rec);
    }
    return { version, fields, records };
}

function parseValue(field, raw) {
    const s = raw.trim();
    switch (field.type) {
        case 'N':
        case 'F':
            if (s === '' || /^\*+$/.test(s)) return null;
            return Number(s);
        case 'D':
            return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
        case 'L':
            return s === '' || s === '?' ? null : /[TtYy]/.test(s);
        default:
            return s.replace(/\0+$/, '');
    }
}

export function writeDbfFile(path, fields, records) {
    writeFileSync(path, buildDbf(fields, records));
}

export function readDbfFile(path) {
    return parseDbf(readFileSync(path));
}
