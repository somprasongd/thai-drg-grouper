// Groups a .json file of cases and gives the same JSON back with a "result" in each case.
//
// The file is an array of case objects, or an object with a "cases" array (what
// /api/v1/group/batch takes). Each case uses the API names (pdx, sdx, admitDate, …), or the
// grouper's .dbf names (PDX, SDX1, DATEADM, …), with the same clean-up as .csv and .xlsx
// files. Every case object gets a "result": what /api/v1/group answers for it (without
// "index"), or { ref, ok: false, version, inputErrors } when the case cannot be grouped.
// Everything else in the file stays as it was. Items that are not objects are left alone.

import { FileFormatError, groupRows, mapColumns, rowToCase } from './tabular.js';

function toCase(obj) {
    const keys = Object.keys(obj);
    let map;
    try {
        map = mapColumns(keys);
    } catch (e) {
        if (e instanceof FileFormatError) return obj; // no pdx: input.js says what is missing
        throw e;
    }
    return rowToCase(map, (i) => obj[keys[i]]);
}

const isCase = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Buffer} input
 * @param {object} options see groupRows in tabular.js
 * @returns {Promise<{ file: Buffer, summary: object }>}
 */
export async function groupJson(input, options) {
    let text = input.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new FileFormatError(`the .json file cannot be read: ${e.message}`);
    }
    const cases = Array.isArray(data) ? data : isCase(data) && Array.isArray(data.cases) ? data.cases : null;
    if (!cases) throw new FileFormatError('the .json file must be an array of cases, or an object with a "cases" array');

    const rows = cases.map((c) => (isCase(c) ? c : null));
    const { results, summary } = await groupRows(toCase, rows, options);
    cases.forEach((c, i) => {
        if (results[i]) c.result = results[i];
    });

    const indent = /^\s*[[{]\s*[\r\n]/.test(text) ? 2 : undefined;
    return { file: Buffer.from(JSON.stringify(data, null, indent) + (indent ? '\n' : ''), 'utf8'), summary: { ...summary, addedFields: ['result'] } };
}
