// Groups an .xlsx workbook and gives the same workbook back with the result columns.
//
// The sheet used is the first visible one with a PDX column in its first rows. Only that
// sheet's XML changes: the result cells are written into its rows (a column named DRG, RW, …
// is written over, the missing ones are added after the last column). Every other part of
// the workbook (other sheets, styles, formulas, Thai text) keeps its bytes as they were.
// Old .xls files (Excel 97-2003) are not read: save them as .xlsx or .csv.

import { FileFormatError, HEADER_SEARCH_ROWS, groupRows, isBlankRow, isHeaderRow, mapColumns, placeResults, resultValues } from './tabular.js';
import { ZipError, inflate, readZip, replace, writeZip } from './zip.js';

const PART_LIMIT = 256 * 1024 * 1024;
const P = '(?:[\\w.-]+:)?'; // a namespace prefix some writers put on every element
const NUMERIC = new Set(['RW', 'ADJRW', 'WTLOS', 'OT', 'ACTLOS', 'ERR', 'WARN']);

const unescape = (s) => s
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
        return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

const escape = (s) => String(s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/_x([0-9a-fA-F]{4})_/g, '_x005F_x$1_');

function attrs(s) {
    const out = {};
    for (const m of s.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unescape(m[2] ?? m[3]);
    return out;
}
const attr = (a, local) => a[local] ?? Object.entries(a).find(([k]) => k.endsWith(`:${local}`))?.[1];

function resolve(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (base + target).split('/');
    const out = [];
    for (const p of parts) {
        if (p === '..') out.pop();
        else if (p !== '.') out.push(p);
    }
    return out.join('/');
}

function rels(text, base) {
    return [...text.matchAll(new RegExp(`<${P}Relationship\\b([^>]*?)/?>`, 'g'))].map((m) => {
        const a = attrs(m[1]);
        return { id: a.Id, type: a.Type ?? '', target: a.TargetMode === 'External' ? null : resolve(base, a.Target ?? '') };
    });
}

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
};

// ---------- styles: which cells hold dates ----------

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]);
const TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

function formatKind(code) {
    if (!code || /^general$/i.test(code)) return null;
    const s = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '').replace(/E[+-]/g, '');
    if (!/[dmyhsb]/i.test(s)) return null;
    return /[dyb]/i.test(s) ? 'date' : /[hs]/i.test(s) ? 'time' : 'date';
}

function readStyles(text) {
    if (!text) return [];
    const custom = new Map();
    for (const m of text.matchAll(new RegExp(`<${P}numFmt\\b([^>]*?)/?>`, 'g'))) {
        const a = attrs(m[1]);
        custom.set(Number(a.numFmtId), a.formatCode);
    }
    const xfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(text);
    if (!xfs) return [];
    return [...xfs[1].matchAll(new RegExp(`<${P}xf\\b([^>]*?)/?>`, 'g'))].map((m) => {
        const id = Number(attrs(m[1]).numFmtId ?? 0);
        if (custom.has(id)) return formatKind(custom.get(id));
        return DATE_IDS.has(id) ? (TIME_IDS.has(id) ? 'time' : 'date') : null;
    });
}

const p2 = (n) => String(n).padStart(2, '0');

/** An Excel date serial → "YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or (time formats) "HH:mm". */
function fromSerial(n, kind, date1904) {
    const minutes = Math.round(n * 1440);
    const hhmm = `${p2(Math.floor((minutes % 1440) / 60))}:${p2(minutes % 60)}`;
    if (kind === 'time' && n < 1) return hhmm;
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.floor(minutes / 1440) * 86400000);
    const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    return minutes % 1440 ? `${date}T${hhmm}` : date;
}

// ---------- the sheet ----------

function readSharedStrings(text) {
    if (!text) return [];
    return [...text.matchAll(new RegExp(`<${P}si\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}si>)`, 'g'))].map((m) => textOf(m[1] ?? ''));
}

function textOf(xml) {
    const plain = xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '');
    let s = '';
    for (const m of plain.matchAll(new RegExp(`<${P}t\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}t>)`, 'g'))) s += unescape(m[1] ?? '');
    return s;
}

/** The rows of a sheet: { r, attrs, start, end, prefix, cells: [{ col, xml, value }] } */
function readRows(xml, ctx) {
    const rows = [];
    const sd = new RegExp(`<(${P})sheetData\\b[^>]*?(?:/>|>([\\s\\S]*?)</\\1sheetData>)`).exec(xml);
    if (!sd || sd[2] === undefined) return { rows, prefix: sd?.[1] ?? '' };
    const base = sd.index + sd[0].indexOf('>') + 1;
    const rowRe = new RegExp(`<(${P})row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1row>)`, 'g');
    const cellRe = new RegExp(`<(${P})c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1c>)`, 'g');
    let lastRow = 0;
    for (const m of sd[2].matchAll(rowRe)) {
        const a = attrs(m[2]);
        const r = a.r ? Number(a.r) : lastRow + 1;
        lastRow = r;
        const cells = [];
        let lastCol = -1;
        for (const c of (m[3] ?? '').matchAll(cellRe)) {
            const ca = attrs(c[2]);
            const ref = /^\$?([A-Z]+)\$?\d*$/.exec(ca.r ?? '');
            const col = ref ? colIndex(ref[1]) : lastCol + 1;
            lastCol = col;
            cells.push({ col, xml: c[0], value: cellValue(ca, c[3] ?? '', ctx), style: ca.s });
        }
        rows.push({ r, rowAttrs: m[2], start: base + m.index, end: base + m.index + m[0].length, prefix: m[1], cells });
    }
    return { rows, prefix: sd[1] };
}

function cellValue(a, inner, { strings, styles, date1904 }) {
    const v = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`).exec(inner)?.[1];
    switch (a.t) {
        case 's':
            return v === undefined ? null : strings[Number(v)] ?? null;
        case 'inlineStr':
            return textOf(new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`).exec(inner)?.[1] ?? '');
        case 'str':
            return v === undefined ? null : unescape(v);
        case 'b':
            return v === undefined ? null : v.trim() === '1' ? 'TRUE' : 'FALSE';
        case 'e':
            return null;
        case 'd':
            return v === undefined ? null : unescape(v).trim();
        default: {
            if (v === undefined || v.trim() === '') return null;
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            const kind = styles[Number(a.s ?? 0)];
            return kind ? fromSerial(n, kind, date1904) : n;
        }
    }
}

function newCell(p, ref, name, value, style) {
    const s = style !== undefined ? ` s="${escape(style)}"` : '';
    if (NUMERIC.has(name) && typeof value === 'number' && Number.isFinite(value)) return `<${p}c r="${ref}"${s}><${p}v>${value}</${p}v></${p}c>`;
    return `<${p}c r="${ref}"${s} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escape(value)}</${p}t></${p}is></${p}c>`;
}

function rewriteRow(row, put, style) {
    const cells = new Map(row.cells.map((c) => [c.col, c.xml]));
    let hadFormula = false;
    for (const [col, name, value] of put) {
        const old = cells.get(col);
        if (old && new RegExp(`<${P}f\\b`).test(old)) hadFormula = true;
        if (value === null || value === undefined || value === '') cells.delete(col);
        else cells.set(col, newCell(row.prefix, `${colName(col)}${row.r}`, name, value, style));
    }
    const rowAttrs = row.rowAttrs.replace(/\s+spans\s*=\s*("[^"]*"|'[^']*')/, '');
    const body = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, xml]) => xml).join('');
    return { xml: `<${row.prefix}row${rowAttrs}>${body}</${row.prefix}row>`, hadFormula };
}

function dropCalcChain(entries, byName) {
    const chain = byName.get('xl/calcChain.xml');
    if (!chain) return entries;
    for (const [name, re] of [
        ['[Content_Types].xml', /<(?:[\w.-]+:)?Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g],
        ['xl/_rels/workbook.xml.rels', /<(?:[\w.-]+:)?Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g],
    ]) {
        const e = byName.get(name);
        if (e) replace(e, Buffer.from(inflate(e, PART_LIMIT).toString('utf8').replace(re, ''), 'utf8'));
    }
    return entries.filter((e) => e !== chain);
}

/**
 * @param {Buffer} input
 * @param {object} options see groupRows in tabular.js
 * @returns {Promise<{ file: Buffer, summary: object, sheet: string }>}
 */
export async function groupXlsx(input, options) {
    let entries;
    try {
        entries = readZip(input);
    } catch (e) {
        if (e instanceof ZipError) throw new FileFormatError(e.message);
        throw e;
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const part = (name) => {
        const e = name && byName.get(name);
        if (!e) return null;
        try {
            return inflate(e, PART_LIMIT).toString('utf8');
        } catch (err) {
            throw new FileFormatError(err.message);
        }
    };

    const root = part('_rels/.rels');
    const bookName = root && rels(root, '').find((r) => r.type.endsWith('/officeDocument'))?.target;
    const book = part(bookName);
    if (!book) throw new FileFormatError('the zip file is not an Excel workbook (.xlsx)');
    const bookDir = bookName.includes('/') ? bookName.slice(0, bookName.lastIndexOf('/') + 1) : '';
    const bookRels = rels(part(`${bookDir}_rels/${bookName.slice(bookDir.length)}.rels`) ?? '', bookDir);
    const ctx = {
        strings: readSharedStrings(part(bookRels.find((r) => r.type.endsWith('/sharedStrings'))?.target)),
        styles: readStyles(part(bookRels.find((r) => r.type.endsWith('/styles'))?.target)),
        date1904: /<(?:[\w.-]+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(book),
    };

    const sheets = [...book.matchAll(new RegExp(`<${P}sheet\\b([^>]*?)/?>`, 'g'))].map((m) => attrs(m[1]))
        .filter((a) => !/hidden/i.test(a.state ?? ''))
        .map((a) => ({ name: a.name, target: bookRels.find((r) => r.id === attr(a, 'id'))?.target }))
        .filter((s) => s.target && byName.has(s.target));

    let found = null;
    for (const s of sheets) {
        const xml = part(s.target);
        const { rows } = readRows(xml, ctx);
        const h = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((row) => isHeaderRow(row.cells.map((c) => c.value)));
        if (h >= 0) {
            found = { ...s, xml, rows, h };
            break;
        }
    }
    if (!found) throw new FileFormatError(`no sheet has a PDX column in its first ${HEADER_SEARCH_ROWS} rows`);
    const { xml, rows, h } = found;

    const headerRow = rows[h];
    const headers = [];
    for (const c of headerRow.cells) headers[c.col] = c.value === null ? '' : String(c.value);
    const map = mapColumns(Array.from(headers, (x) => x ?? ''));
    const data = rows.slice(h + 1);
    const width = Math.max(headers.length, ...data.map((r) => (r.cells.length ? r.cells[r.cells.length - 1].col + 1 : 0)));
    const { columns, added } = placeResults(Array.from(headers, (x) => x ?? ''), width);

    const getters = data.map((r) => {
        const byCol = new Map(r.cells.map((c) => [c.col, c.value]));
        return isBlankRow([...byCol.values()]) ? null : (i) => byCol.get(i);
    });
    const { results, summary } = await groupRows(map, getters, options);

    // rebuild the sheet: the changed rows, the rest as it was
    const headerStyle = headerRow.cells.find((c) => c.col === map.fields.find((f) => f.key === 'pdx').index)?.style;
    const changes = [];
    let hadFormula = false;
    const headerPut = columns.filter((c) => c.added).map((c) => [c.index, 'header', c.name]);
    changes.push({ row: headerRow, ...rewriteRow(headerRow, headerPut, headerStyle) });
    data.forEach((row, k) => {
        const values = resultValues(results[k]);
        if (!values) return;
        const out = rewriteRow(row, columns.map((c) => [c.index, c.name, values[c.name]]));
        hadFormula ||= out.hadFormula;
        changes.push({ row, ...out });
    });
    let sheet = '';
    let at = 0;
    for (const c of changes) {
        sheet += xml.slice(at, c.row.start) + c.xml;
        at = c.row.end;
    }
    sheet += xml.slice(at);

    const lastCol = Math.max(width, ...columns.map((c) => c.index + 1)) - 1;
    const lastRow = rows.length ? rows[rows.length - 1].r : 1;
    sheet = sheet.replace(new RegExp(`(<${P}dimension\\b[^>]*\\bref\\s*=\\s*")([^"]*)(")`), (m, a, ref, b) => {
        const [first, last = first] = ref.split(':');
        const end = /^([A-Z]+)(\d+)$/.exec(last);
        const endCol = end ? Math.max(colIndex(end[1]), lastCol) : lastCol;
        const endRow = end ? Math.max(Number(end[2]), lastRow) : lastRow;
        return `${a}${first}:${colName(endCol)}${endRow}${b}`;
    });

    replace(byName.get(found.target), Buffer.from(sheet, 'utf8'));
    const out = hadFormula ? dropCalcChain(entries, byName) : entries;
    return { file: writeZip(out), summary: { ...summary, addedFields: added, sheet: found.name }, sheet: found.name };
}
