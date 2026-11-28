// Which kind of file was sent, read from its bytes (not from the name or the Content-Type),
// and the grouping of it: .dbf, .csv, .xlsx or .json. The answer is always the same kind
// of file with the results added.

import { groupDbf } from './dbffile.js';
import { groupCsv } from './csvfile.js';
import { groupJson } from './jsonfile.js';
import { FileFormatError } from './tabular.js';
import { groupXlsx } from './xlsxfile.js';

export { FileFormatError };

export const FORMATS = {
    dbf: { ext: 'dbf', type: 'application/octet-stream' },
    csv: { ext: 'csv', type: 'text/csv; charset=utf-8' },
    xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    json: { ext: 'json', type: 'application/json; charset=utf-8' },
};

function looksLikeDbf(buf) {
    // dBASE III/IV/5, FoxPro and Visual FoxPro version bytes
    if (buf.length < 33 || ![0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0x8e, 0xcb, 0xf5, 0xfb].includes(buf[0])) return false;
    const month = buf[2];
    const day = buf[3];
    // the header date: control bytes in a text file; a bad dbf header is then told by groupDbf
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** 'dbf', 'csv', 'xlsx' or 'json'; throws FileFormatError for anything else. */
export function detectFormat(buf) {
    if (!buf.length) throw new FileFormatError('the file is empty');
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'xlsx';
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
        throw new FileFormatError('this is an old Excel file (.xls) or another Office 97-2003 file: save it as .xlsx or .csv and send that');
    }
    if (looksLikeDbf(buf)) return 'dbf';
    const head = buf.subarray(0, 64 * 1024);
    if (head.includes(0)) throw new FileFormatError('the file is not a .dbf, .csv, .xlsx or .json file');
    const first = /\S/.exec(head.toString('latin1').replace(/^\xef\xbb\xbf/, ''))?.[0];
    if (first === '[' || first === '{') return 'json';
    return 'csv';
}

/**
 * @param {Buffer} buf the file
 * @param {object} o { group(records), pool, maxRecords }
 * @returns {Promise<{ format, file: Buffer, summary: object, contentType: string, ext: string }>}
 */
export async function groupFile(buf, { group, pool, maxRecords }) {
    const format = detectFormat(buf);
    let out;
    if (format === 'dbf') out = await groupDbf(buf, group, { maxRecords });
    else if (format === 'csv') out = await groupCsv(buf, { group, pool, maxRecords });
    else if (format === 'xlsx') out = await groupXlsx(buf, { group, pool, maxRecords });
    else out = await groupJson(buf, { group, pool, maxRecords });
    let contentType = FORMATS[format].type;
    if (format === 'csv') contentType = `text/csv; charset=${out.encoding}`;
    return { format, file: out.file, summary: out.summary, contentType, ext: FORMATS[format].ext };
}
