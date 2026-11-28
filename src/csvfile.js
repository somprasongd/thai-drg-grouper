// Groups a .csv file and gives the same file back with the result columns.
//
// The file is worked on as bytes (latin1), so every byte of the other columns, the quoting,
// the line ends and a UTF-8 BOM stay as they were, in UTF-8 or in TIS-620/Windows-874 (what
// Thai Excel writes). Only the result columns change: a column named DRG, RW, … is written
// over, the missing ones are added after the last column. The separator (, ; or tab) is the
// one the header row uses.

import { FileFormatError, HEADER_SEARCH_ROWS, groupRows, isBlankRow, isHeaderRow, mapColumns, placeResults, resultValues } from './tabular.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const thai = new TextDecoder('windows-874');

function pickEncoding(buf) {
    try {
        utf8.decode(buf);
        return 'utf-8';
    } catch {
        return 'windows-874';
    }
}

/** Windows-874: ASCII, Thai (U+0E01–U+0E5B at 0xA1–0xFB) and a few signs; others become "?". */
function encode874(s) {
    const out = Buffer.alloc(s.length);
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out[n++] = c;
        else if (c >= 0x0e01 && c <= 0x0e5b) out[n++] = c - 0x0d60;
        else out[n++] = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0xa0: 0xa0 }[c] ?? 0x3f;
    }
    return out.subarray(0, n);
}

/**
 * Split the text into rows of raw fields. Each row: { fields: string[] (raw, with quotes),
 * eol: the line end that followed it ('' for the last line) }.
 */
function splitRows(s, sep) {
    const rows = [];
    let fields = [];
    let start = 0;
    let i = 0;
    let quoted = false;
    const n = s.length;
    while (i < n) {
        const ch = s[i];
        if (quoted) {
            if (ch === '"') {
                if (s[i + 1] === '"') i++;
                else quoted = false;
            }
            i++;
            continue;
        }
        if (ch === '"' && i === start) {
            quoted = true;
            i++;
        } else if (ch === sep) {
            fields.push(s.slice(start, i));
            start = ++i;
        } else if (ch === '\r' || ch === '\n') {
            fields.push(s.slice(start, i));
            const eol = ch === '\r' && s[i + 1] === '\n' ? '\r\n' : ch;
            rows.push({ fields, eol });
            fields = [];
            i += eol.length;
            start = i;
        } else {
            i++;
        }
    }
    if (quoted) throw new FileFormatError('the .csv file ends inside a quoted value');
    if (start < n || fields.length) {
        fields.push(s.slice(start, n));
        rows.push({ fields, eol: '' });
    }
    return rows;
}

function pickSeparator(firstLines) {
    let best = ',';
    let most = 0;
    for (const sep of [',', ';', '\t', '|']) {
        const count = firstLines.split(sep).length - 1;
        if (count > most) {
            best = sep;
            most = count;
        }
    }
    return best;
}

/**
 * @param {Buffer} input
 * @param {object} options see groupRows in tabular.js
 * @returns {Promise<{ file: Buffer, summary: object, encoding: string }>}
 */
export async function groupCsv(input, options) {
    const encoding = pickEncoding(input);
    const decode = encoding === 'utf-8' ? (raw) => Buffer.from(raw, 'latin1').toString('utf8') : (raw) => thai.decode(Buffer.from(raw, 'latin1'));
    const toRaw = encoding === 'utf-8' ? (t) => Buffer.from(t, 'utf8').toString('latin1') : (t) => encode874(t).toString('latin1');

    let s = input.toString('latin1');
    const bom = s.startsWith('\xef\xbb\xbf') ? '\xef\xbb\xbf' : '';
    s = s.slice(bom.length);
    const sep = pickSeparator(s.slice(0, 64 * 1024).split(/\r\n|\r|\n/).slice(0, HEADER_SEARCH_ROWS).join('\n'));
    const rows = splitRows(s, sep);

    const value = (raw) => {
        if (raw === undefined) return null;
        const t = raw.length >= 2 && raw[0] === '"' && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
        return decode(t).trim();
    };
    const h = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((r) => isHeaderRow(r.fields.map(value)));
    if (h < 0) throw new FileFormatError(`no PDX column in the first ${HEADER_SEARCH_ROWS} lines of the .csv file`);
    const headers = rows[h].fields.map(value);
    const map = mapColumns(headers);

    const data = rows.slice(h + 1);
    const width = Math.max(headers.length, ...data.map((r) => r.fields.length));
    const { columns, added } = placeResults(headers, width);
    const getters = data.map((r) => {
        const values = r.fields.map(value);
        return isBlankRow(values) ? null : (i) => values[i];
    });
    const { results, summary } = await groupRows(map, getters, options);

    const quote = (t) => {
        let v = String(t);
        if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // never a formula when the file is opened in a spreadsheet
        return /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const put = (fields, index, raw) => {
        while (fields.length < index) fields.push('');
        fields[index] = raw;
    };
    const header = [...rows[h].fields];
    for (const c of columns) if (c.added) put(header, c.index, toRaw(quote(c.name)));
    rows[h] = { fields: header, eol: rows[h].eol };
    data.forEach((r, k) => {
        const values = resultValues(results[k]);
        if (!values) return;
        const fields = [...r.fields];
        for (const c of columns) {
            const v = values[c.name];
            put(fields, c.index, v === null || v === undefined ? '' : toRaw(quote(v)));
        }
        rows[h + 1 + k] = { fields, eol: r.eol };
    });

    const out = bom + rows.map((r) => r.fields.join(sep) + r.eol).join('');
    return { file: Buffer.from(out, 'latin1'), summary: { ...summary, addedFields: added }, encoding };
}
