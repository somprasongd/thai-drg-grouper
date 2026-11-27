// Build the rule file of the native grouper from the TCMC Thai DRG 6.3.3 books.
//
//   node tools/build-rules.mjs <folder with the pdftotext -raw text files> [out.json]
//
// The text files are made with xpdf/poppler pdftotext:
//   pdftotext -raw -enc UTF-8 TDrg633Vol1OneFinC.pdf TDrg633Vol1OneFinC.txt   (and Vol2, VSup11..VSup55)
// The books are free downloads from https://www.tcmc.or.th (S0062: books 1-2, S0063: Appendix F).
// npm run setup (tools/setup.mjs) downloads them, makes the text files and runs this script.
// The output has no time stamp, so the same books always give the same file.
// The tables that the grouper ships as dbf files (c63i10, c63proc, c63drg, c63ccex) are not
// copied here: the engine reads them as they are.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , srcDir, outFile = 'groupers/6.3.4/native/rules.json'] = process.argv;
if (!srcDir) {
    console.error('usage: node tools/build-rules.mjs <raw text folder> [out.json]');
    process.exit(2);
}
// poppler pdftotext glues the page footer to the last line of a page
// ("1007:2AppendixF1(DxCodesK-O)"); xpdf puts it on a line of its own. Cut it off so both give
// the same lines.
const GLUED_FOOTER = /(?<=\S)(?:Appendix ?F\d? ?\(.*\)|Thai ?DRG ?Version ?6\.3\.3)$/;
const read = (name) => readFileSync(join(srcDir, name), 'utf8').replace(/\f/g, '\n').split(/\r?\n/)
    .map((l) => l.trim().replace(GLUED_FOOTER, '').trim());

const isNoise = (l) => l === '' || /^\d+$/.test(l) || /^Thai DRG Version/i.test(l) || /^Major Diagnostic Category/.test(l)
    || /^Code (PDC )?Desc/.test(l) || /^Code Site Desc/.test(l) || /^_{5,}$/.test(l) || /^-{5,}$/.test(l);

// ---------------------------------------------------------------- Appendix F1: DCL
function parseDcl() {
    const dcl = {};
    const refs = {};
    for (const part of ['TDrg633VSup11FinC.txt', 'TDrg633VSup22FinC.txt', 'TDrg633VSup33FinC.txt', 'TDrg633VSup44FinC.txt']) {
        const lines = read(part);
        let started = false;
        let code = null;
        for (const l of lines) {
            if (!started) {
                if (l === 'DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL DC:DCL') started = true;
                continue;
            }
            let m;
            if ((m = /^([A-Z]\d{2}[0-9A-Z]{0,3})$/.exec(l))) {
                code = m[1];
                if (!dcl[code]) dcl[code] = {};
            } else if (code && (m = /^(\d{4}):(\d)$/.exec(l))) {
                dcl[code][m[1]] = Number(m[2]);
            } else if (code && (m = /^= ([A-Z]\d{2}[0-9A-Z]{0,3})$/.exec(l))) {
                refs[code] = m[1];
            }
        }
    }
    for (const [code, to] of Object.entries(refs)) {
        let t = to;
        for (let i = 0; i < 5 && refs[t]; i++) t = refs[t];
        dcl[code] = dcl[t] || {};
    }
    // compact form: "DDDDL DDDDL ..."
    const out = {};
    for (const [code, m] of Object.entries(dcl)) {
        const s = Object.entries(m).filter(([, v]) => v > 0).map(([dc, v]) => dc + v).join(' ');
        if (s) out[code] = s;
    }
    return out;
}

// ---------------------------------------------------------------- Book 2: assignments, AX, DC definitions
const DX = '[A-Z]\\d{2}[0-9A-Z]{0,3}';
const PROC = '(?:\\d{2,4}(?:[>*]\\d)?|C\\d{4}|C[A-Z]\\d{3})';

function parseBook2() {
    const lines = read('TDrg633Vol2TwoFinC.txt');
    const dxPdc = {};      // mdc -> code -> pdc
    const procPdc = {};    // mdc -> code -> [pdc]
    const ax = {};         // name -> { kind, mdc, desc, codes: [] }
    const dcs = [];
    const order = [];      // DC numbers in book order
    let mode = null;       // dxPdc | procPdc | axdx | axproc | def
    let mdc = null;
    let curAx = null;
    let curDc = null;
    let started = false;
    let i = 0;
    for (; i < lines.length; i++) {
        const l = lines[i];
        let m;
        if ((m = /^(?:Pre ?MDC|MDC ?(\d+)) ASSIGNMENT OF ICD-(10|9-CM) CODES?$/.exec(l))) {
            started = true;
            mdc = m[1] ? String(Number(m[1])).padStart(2, '0') : '00';
            mode = m[2] === '10' ? 'dxPdc' : 'procPdc';
            curAx = null;
            curDc = null;
            continue;
        }
        if (!started) continue;
        if (/^AX ASSIGNMENT OF ICD-10 CODES$/.test(l)) { mode = 'axdx'; curAx = null; continue; }
        if (/^AX ASSIGNMENT OF ICD-9-CM CODES$/.test(l)) { mode = 'axproc'; curAx = null; continue; }
        if (/^DC and DRG Definition$/.test(l)) { mode = 'def'; curDc = null; continue; }
        if (/Partitioning/.test(l) && mode === 'def') { mode = null; continue; }
        if (/^AX 99\.\.$/.test(l)) { mdc = '99'; mode = null; continue; }
        if (/^Definition of AX used in more than 1 MDC/.test(l)) { mdc = '99'; continue; }
        if (/^ค/.test(l) && mdc === '99') break; // abbreviations after AX 99
        if (isNoise(l) || l === '<NONE>') continue;

        if (mode === 'dxPdc') {
            if ((m = new RegExp(`^(${DX}) (\\d{1,2}[A-Z]{1,2}) `).exec(l + ' '))) {
                (dxPdc[mdc] ||= {})[m[1]] = m[2];
            } else if ((m = new RegExp(`^(${DX}) (\\d) `).exec(l + ' ')) && mdc === '24') {
                // MDC 24 lists the trauma site instead of a PDC (the dbf has it as TRAUMA)
            }
        } else if (mode === 'procPdc') {
            if ((m = new RegExp(`^(${PROC}) (\\d{1,2}[PQ][A-Z]{1,2}) `).exec(l + ' '))) {
                const list = ((procPdc[mdc] ||= {})[m[1]] ||= []);
                if (!list.includes(m[2])) list.push(m[2]);
            }
        } else if (mode === 'axdx' || mode === 'axproc') {
            if ((m = /^AX (\d{1,2}P?[A-Z]{1,2}X) ?(.*)$/.exec(l))) {
                curAx = m[1];
                ax[curAx] = { kind: mode === 'axdx' ? 'dx' : 'proc', mdc, desc: m[2], codes: [] };
                continue;
            }
            if (!curAx) continue;
            const re = mode === 'axdx' ? new RegExp(`^(${DX}) `) : new RegExp(`^(${PROC}(?: & ${PROC})?) `);
            if ((m = re.exec(l + ' '))) ax[curAx].codes.push(m[1].replace(/ & /, '&'));
        } else if (mode === 'def') {
            if ((m = /^DC (\d{4}) (.*)$/.exec(l))) {
                curDc = { dc: m[1], name: m[2], cond: [], drgs: [] };
                dcs.push(curDc);
                order.push(m[1]);
                continue;
            }
            if (!curDc) continue;
            if ((m = /^DRG (\d{5}): DC (\d{4})(?: w PCL (\d)(?: ?- ?(\d))?)?/.exec(l))) {
                curDc.drgs.push({ drg: m[1], lo: m[3] === undefined ? null : Number(m[3]), hi: m[4] === undefined ? (m[3] === undefined ? null : Number(m[3])) : Number(m[4]) });
                continue;
            }
            if (curDc.drgs.length) continue;
            curDc.cond.push(l);
        }
    }
    // A sentence in the PDx reassignment rules of MDC 14 ("... assign as / DC 1452 to this case.")
    // looks like a DC heading in the xpdf text. A real DC always has DRG lines, so drop the ones without.
    return { dxPdc, procPdc, ax, dcs: dcs.filter((d) => d.drgs.length) };
}

// ---------------------------------------------------------------- Book 1: A1 dagger/asterisk, C combinations
function parseBook1() {
    const lines = read('TDrg633Vol1OneFinC.txt');
    const dagger = [];
    const combos = {};
    let mode = null;
    for (const l of lines) {
        if (l === 'Appendix A1') { mode = 'a1'; continue; }
        if (l === 'Appendix A2') { mode = null; continue; }
        if (l === 'Appendix C') { mode = 'c'; continue; }
        if (l === 'Appendix D') { mode = null; continue; }
        let m;
        if (mode === 'a1') {
            const re = new RegExp(`(${DX}) (${DX}) (${DX}) (\\d{2})`, 'g');
            while ((m = re.exec(l))) dagger.push([m[1], m[2], m[3], m[4]]);
        } else if (mode === 'c') {
            if ((m = /^(C\d{4}|CE\d{3}) (\d{2,4}) .*& (\d{2,4}) /.exec(l))) combos[m[1]] = [m[2], m[3]];
        }
    }
    return { dagger, combos };
}

const dcl = parseDcl();
const book2 = parseBook2();
const book1 = parseBook1();

const rules = {
    source: 'TCMC Thai DRG version 6.3.3 books 1-2 and Appendix F1 (www.tcmc.or.th); tables c63*.dbf of TGrp6305 (6.3.4)',
    dcl,
    ...book2,
    ...book1,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(rules));

const n = (o) => Object.keys(o).length;
console.log('DCL codes', n(dcl));
console.log('dx PDC by MDC', Object.entries(book2.dxPdc).map(([k, v]) => `${k}:${n(v)}`).join(' '));
console.log('proc PDC by MDC', Object.entries(book2.procPdc).map(([k, v]) => `${k}:${n(v)}`).join(' '));
console.log('AX', n(book2.ax), Object.entries(book2.ax).map(([k, v]) => `${k}:${v.codes.length}`).join(' '));
console.log('DCs', book2.dcs.length, 'DRGs', book2.dcs.reduce((a, d) => a + d.drgs.length, 0));
console.log('dagger pairs', book1.dagger.length, 'combinations', n(book1.combos));
