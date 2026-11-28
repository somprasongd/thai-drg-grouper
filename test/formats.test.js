// The .csv, .xlsx and .json file formats, with a stand-in grouper (no TCMC files needed).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { groupCsv } from '../src/csvfile.js';
import { detectFormat } from '../src/files.js';
import { groupJson } from '../src/jsonfile.js';
import { FileFormatError, normDate, normTime, rowToCase, mapColumns } from '../src/tabular.js';
import { groupXlsx } from '../src/xlsxfile.js';
import { inflate, readZip, replace, writeZip } from '../src/zip.js';

const pool = { version: '6.3.4', engine: 'native', drgTable: new Map([['06070', { name: 'Appendectomy w/o complicated principal diagnosis' }]]) };

/** a stand-in grouper: the DRG comes from the PDX so the tests can tell records apart */
function fakeGroup() {
    const seen = [];
    const group = async (records) => {
        seen.push(...records);
        return records.map((r) => (r.PDX === 'BAD'
            ? { DRG: '26509', MDC: '26', ERR: 2, WARN: 0, RW: 0, ADJRW: 0, WTLOS: 0, OT: 0, ACTLOS: 3 }
            : { DRG: '06070', MDC: '06', ERR: 0, WARN: 0, RW: 1.2127, ADJRW: 1.2127, WTLOS: 3.05, OT: 9, ACTLOS: 3 }));
    };
    return { group, seen, pool };
}

function fakeRunner() {
    const { group, seen } = fakeGroup();
    const versions = new Map([['6.3.4', { ...pool, name: 'Thai DRG 6.3.4', stats: { runs: 0, cases: 0, failures: 0, totalMs: 0 } }]]);
    return { versions, group: (version, records) => group(records), queued: 0, seen };
}

/** "สมชาย" in Windows-874 */
const SOMCHAI_874 = Buffer.from([0xca, 0xc1, 0xa8, 0xd2, 0xc2]);

describe('values from spreadsheets', () => {
    test('dates: D/M/YYYY, Buddhist era, YYYYMMDD, with a time', () => {
        assert.equal(normDate('10/1/2567'), '2024-01-10');
        assert.equal(normDate('10/01/2024 8.30'), '2024-01-10T08:30');
        assert.equal(normDate('2567-01-10'), '2024-01-10');
        assert.equal(normDate('2024-01-10 08:30:00'), '2024-01-10T08:30');
        assert.equal(normDate('25670110'), '2024-01-10');
        assert.equal(normDate('soon'), 'soon');
    });

    test('times: 830, 8.30, 08:30:00', () => {
        assert.equal(normTime(830), '08:30');
        assert.equal(normTime('1000'), '10:00');
        assert.equal(normTime('8.30'), '08:30');
        assert.equal(normTime('08:30:00'), '08:30');
        assert.equal(normTime(''), undefined);
    });

    test('columns: API names, .dbf names, SDXn/PROCn, lists, numeric procedures', () => {
        const headers = ['HN', 'Sex', 'DATE_ADM', 'Time Adm', 'PDX', 'SDX2', 'sdx1', 'proc1', 'Procedures'];
        const map = mapColumns(headers);
        const row = ['1', 1, '10/01/2567', 830, 'K35.8', 'I10', 'E11.9', 1.25, '47.09, 54.11'];
        assert.deepEqual(rowToCase(map, (i) => row[i]), {
            sex: '1', admitDate: '2024-01-10', admitTime: '08:30', pdx: 'K35.8',
            sdx: ['E11.9', 'I10'], procedures: ['47.09', '54.11', '01.25'],
        });
        assert.throws(() => mapColumns(['HN', 'NAME']), FileFormatError);
    });

    test('the kind of file is told from its bytes', () => {
        assert.equal(detectFormat(Buffer.from('PDX\nK358\n')), 'csv');
        assert.equal(detectFormat(Buffer.from('﻿ [{"pdx":"K35.8"}]')), 'json');
        assert.equal(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), 'xlsx');
        assert.throws(() => detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /\.xls/);
        assert.throws(() => detectFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0])), /not a \.dbf, \.csv/);
        assert.throws(() => detectFormat(Buffer.alloc(0)), /empty/);
    });
});

describe('.csv files', () => {
    test('UTF-8 with a BOM and CRLF: the other columns, Thai text and blank lines stay', async () => {
        const csv = '﻿รายงานผู้ป่วยใน\r\n'
            + 'HN,ชื่อ,sex,dob,admitDate,admitTime,dischargeDate,dischargeTime,dischargeType,pdx,procedures\r\n'
            + '001,"สมชาย, ใจดี",1,10/05/2523,10/01/2567,830,13/01/2567,1000,1,K35.8,47.09\r\n'
            + ',,,,,,,,,,\r\n'
            + '002,สมหญิง,2,1980-05-10,2024-01-10,08:30,2024-01-13,10:00,1,BAD,\r\n'
            + '003,ผิด,2,1980-05-10,next week,,2024-01-13,10:00,1,K35.8,\r\n';
        const g = fakeGroup();
        const { file, summary, encoding } = await groupCsv(Buffer.from(csv, 'utf8'), g);
        assert.equal(encoding, 'utf-8');
        assert.deepEqual(
            { records: summary.records, grouped: summary.grouped, rejected: summary.rejected, skipped: summary.skipped, withError: summary.withError },
            { records: 3, grouped: 2, rejected: 1, skipped: 1, withError: 1 });
        assert.equal(summary.addedFields.length, 13);
        assert.equal(g.seen[0].DATEADM, '2024-01-10');
        assert.equal(g.seen[0].DOB, '1980-05-10');
        assert.equal(g.seen[0].TIMEADM, '0830');

        const out = file.toString('utf8');
        assert.ok(out.startsWith('﻿รายงานผู้ป่วยใน\r\n'));
        const lines = out.split('\r\n');
        assert.equal(lines.length, 7);
        assert.equal(lines[1], 'HN,ชื่อ,sex,dob,admitDate,admitTime,dischargeDate,dischargeTime,dischargeType,pdx,procedures,DRG,DRGNAME,MDC,RW,ADJRW,WTLOS,OT,ACTLOS,ERR,ERRMSG,WARN,WARNMSG,GRPNOTE');
        assert.ok(lines[2].startsWith('001,"สมชาย, ใจดี",1,10/05/2523,10/01/2567,830,13/01/2567,1000,1,K35.8,47.09,06070,Appendectomy w/o complicated principal diagnosis,06,1.2127,1.2127,3.05,9,3,0,,0,,'));
        assert.equal(lines[3], ',,,,,,,,,,');
        assert.match(lines[4], /,BAD,,26509,,26,0,0,0,0,3,2,/);
        assert.match(lines[5], /^003,ผิด,.*,,,,,,,,,,,,"?admitDate: ""?next week/);
        assert.equal(lines[6], '');
    });

    test('Windows-874 with ; and the .dbf names: a DRG column is written over, Thai bytes stay', async () => {
        const head = Buffer.from('NAME;PDX;SDX1;PROC1;DRG;DATEADM;TIMEADM;DATEDSC;TIMEDSC;DOB;SEX;DISCHT\n', 'latin1');
        const row = Buffer.concat([SOMCHAI_874, Buffer.from(';K358;;4709;old;20240110;0830;20240113;1000;19800510;1;1\n', 'latin1')]);
        const g = fakeGroup();
        const { file, summary, encoding } = await groupCsv(Buffer.concat([head, row]), g);
        assert.equal(encoding, 'windows-874');
        assert.equal(summary.grouped, 1);
        assert.ok(!summary.addedFields.includes('DRG'));
        assert.equal(g.seen[0].PDX, 'K358');
        assert.equal(g.seen[0].DATEADM, '2024-01-10');
        assert.ok(file.subarray(0, head.length).toString('latin1').startsWith('NAME;PDX;SDX1;PROC1;DRG;DATEADM'));
        const second = file.subarray(file.indexOf(0x0a) + 1);
        assert.deepEqual(second.subarray(0, 5), SOMCHAI_874);
        assert.match(second.toString('latin1'), /^.{5};K358;;4709;06070;20240110;/);
    });

    test('no PDX column is a FileFormatError', async () => {
        await assert.rejects(groupCsv(Buffer.from('HN,NAME\n1,a\n'), fakeGroup()), FileFormatError);
    });
});

describe('.json files', () => {
    test('an array: each case gets a result, other items stay', async () => {
        const cases = [
            { ref: 'A1', sex: 1, dob: '1980-05-10', admitDate: '2024-01-10T08:30', dischargeDate: '2024-01-13T10:00', dischargeType: 1, pdx: 'K35.8', procedures: ['47.09'], ward: 'ศัลยกรรม' },
            { ref: 'A2', SEX: '1', DOB: '10/05/2523', DATEADM: '10/01/2567', TIMEADM: '0830', DATEDSC: '13/01/2567', TIMEDSC: '1000', DISCHT: '1', PDX: 'K358', PROC1: '4709' },
            'not a case',
            { ref: 'A3', pdx: 'K35.8', admitDate: 'tomorrow' },
        ];
        const g = fakeGroup();
        const { file, summary } = await groupJson(Buffer.from(JSON.stringify(cases, null, 2)), g);
        assert.deepEqual([summary.records, summary.grouped, summary.rejected, summary.skipped], [3, 2, 1, 1]);
        const out = JSON.parse(file.toString('utf8'));
        assert.match(file.toString('utf8'), /^\[\n {2}\{/);
        assert.equal(out[0].ward, 'ศัลยกรรม');
        assert.equal(out[0].result.drg, '06070');
        assert.equal(out[0].result.ref, 'A1');
        assert.equal(out[0].result.index, undefined);
        assert.equal(out[1].result.drg, '06070');
        assert.equal(g.seen[1].DATEADM, '2024-01-10');
        assert.equal(out[2], 'not a case');
        assert.equal(out[3].result.ok, false);
        assert.match(out[3].result.inputErrors[0], /admitDate/);
    });

    test('{ cases: [...] } keeps the rest of the object; anything else is a FileFormatError', async () => {
        const { file } = await groupJson(Buffer.from('{"batch":7,"cases":[{"pdx":"K35.8","sex":1}]}'), fakeGroup());
        const out = JSON.parse(file);
        assert.equal(out.batch, 7);
        assert.equal(out.cases[0].result.ok, true);
        assert.ok(!file.toString().includes('\n'));
        await assert.rejects(groupJson(Buffer.from('{"a":1}'), fakeGroup()), FileFormatError);
        await assert.rejects(groupJson(Buffer.from('[1,'), fakeGroup()), FileFormatError);
    });
});

// ---------- .xlsx ----------

const xml = (s) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function buildXlsx(sheetData, { strings = [], dimension = 'A1:D3', extra = '' } = {}) {
    const parts = {
        '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
        '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
        'xl/workbook.xml': xml(`<workbook ${NS}><sheets><sheet name="Notes" sheetId="2" r:id="rId2"/><sheet name="IPD" sheetId="1" r:id="rId1"/></sheets></workbook>`),
        'xl/_rels/workbook.xml.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
        'xl/sharedStrings.xml': xml(`<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si>${s}</si>`).join('')}</sst>`),
        // style 1: built-in date (14), style 2: built-in time (20), style 3: custom d/m/yyyy h:mm, style 4: bold header
        'xl/styles.xml': xml(`<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="d/m/yyyy\\ h:mm"/></numFmts><fonts count="2"><font/><font><b/></font></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="20" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>`),
        'xl/worksheets/sheet1.xml': xml(`<worksheet ${NS}><dimension ref="${dimension}"/><sheetData>${sheetData}</sheetData>${extra}</worksheet>`),
        'xl/worksheets/sheet2.xml': xml(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>no cases here</t></is></c></row></sheetData></worksheet>`),
    };
    const entries = Object.entries(parts).map(([name, text]) => {
        const e = { name, flags: 0, method: 0, time: 0, date: 0x21, crc: 0, size: 0, raw: Buffer.alloc(0), madeBy: 20, needed: 20, internal: 0, external: 0 };
        replace(e, Buffer.from(text, 'utf8'));
        return e;
    });
    return writeZip(entries);
}

const sheetOf = (buf) => inflate(readZip(buf).find((e) => e.name === 'xl/worksheets/sheet1.xml'), 1e8).toString('utf8');

// 45301 = 2024-0110, 0.3541666… = 08:30, 29351 = 1980-05-10
const SHEET = [
    '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c></row>',
    '<row r="2" spans="1:12"><c r="A2" t="s" s="4"><v>1</v></c><c r="B2" t="s" s="4"><v>2</v></c><c r="C2" t="s" s="4"><v>3</v></c><c r="D2" t="s" s="4"><v>4</v></c><c r="E2" t="s" s="4"><v>5</v></c><c r="F2" t="s" s="4"><v>6</v></c><c r="G2" t="s" s="4"><v>7</v></c><c r="H2" t="s" s="4"><v>8</v></c><c r="I2" t="s" s="4"><v>9</v></c><c r="J2" t="s" s="4"><v>10</v></c><c r="L2" t="s" s="4"><v>11</v></c></row>',
    '<row r="3" spans="1:12"><c r="A3"><v>1</v></c><c r="B3" t="s"><v>12</v></c><c r="C3" s="1"><v>29351</v></c><c r="D3" s="3"><v>45301.354166666664</v></c><c r="E3" s="1"><v>45304</v></c><c r="F3" s="2"><v>0.41666666666666669</v></c><c r="G3"><v>1</v></c><c r="H3" t="str"><f>"K35.8"</f><v>K35.8</v></c><c r="I3"><v>47.09</v></c><c r="J3"><v>1</v></c><c r="L3" t="inlineStr"><is><t>old</t></is></c></row>',
    '<row r="4"/>',
    '<row r="5"><c r="A5"><v>2</v></c><c r="H5" t="inlineStr"><is><t>BAD</t></is></c><c r="K5" t="b"><v>0</v></c></row>',
].join('');
const STRINGS = [
    '<t>รายงาน IPD</t>', '<t>HN</t>', '<r><t>ชื่อ</t></r><rPh><t>ignored</t></rPh>', '<t>dob</t>', '<t>admitDate</t>', '<t>dischargeDate</t>',
    '<t>dischargeTime</t>', '<t>dischargeType</t>', '<t>PDX</t>', '<t>procedures</t>', '<t>sex</t>', '<t>DRG</t>', '<t>สมชาย &amp; co</t>',
];

describe('.xlsx files', () => {
    test('the sheet with a PDX column is grouped; dates, times and numeric codes are read', async () => {
        const g = fakeGroup();
        const input = buildXlsx(SHEET, { strings: STRINGS, dimension: 'A1:L5' });
        const { file, summary } = await groupXlsx(input, g);
        assert.equal(summary.sheet, 'IPD');
        assert.deepEqual([summary.records, summary.grouped, summary.rejected, summary.skipped], [2, 2, 0, 1]);
        assert.ok(!summary.addedFields.includes('DRG'));
        assert.equal(summary.addedFields[0], 'DRGNAME');
        assert.deepEqual(
            { DOB: g.seen[0].DOB, DATEADM: g.seen[0].DATEADM, TIMEADM: g.seen[0].TIMEADM, DATEDSC: g.seen[0].DATEDSC, TIMEDSC: g.seen[0].TIMEDSC, PDX: g.seen[0].PDX, PROC1: g.seen[0].PROC1, SEX: g.seen[0].SEX },
            { DOB: '1980-05-10', DATEADM: '2024-01-10', TIMEADM: '0830', DATEDSC: '2024-01-13', TIMEDSC: '1000', PDX: 'K358', PROC1: '4709', SEX: '1' });
        assert.equal(g.seen[1].PDX, 'BAD');

        const sheet = sheetOf(file);
        assert.match(sheet, /<dimension ref="A1:X5"\/>/);
        // header: added names in the style of the PDX header, after the last column
        assert.match(sheet, /<c r="M2" s="4" t="inlineStr"><is><t xml:space="preserve">DRGNAME<\/t><\/is><\/c>/);
        assert.match(sheet, /<c r="X2" s="4" t="inlineStr"><is><t xml:space="preserve">GRPNOTE<\/t><\/is><\/c><\/row>/);
        // the old DRG cell is written over; RW is a number; the formula cell stays
        assert.match(sheet, /<c r="L3" t="inlineStr"><is><t xml:space="preserve">06070<\/t><\/is><\/c><c r="M3" t="inlineStr">/);
        assert.match(sheet, /<c r="O3"><v>1.2127<\/v><\/c>/);
        assert.match(sheet, /<c r="H3" t="str"><f>"K35.8"<\/f><v>K35.8<\/v><\/c>/);
        assert.match(sheet, /<row r="1" spans="1:3"><c r="A1" t="s"><v>0<\/v><\/c><\/row>/);
        assert.match(sheet, /<row r="4"\/>/);
        assert.ok(!/<row r="3" spans/.test(sheet));
        // cells stay in column order
        for (const row of sheet.matchAll(/<row [^>]*>(.*?)<\/row>/g)) {
            const cols = [...row[1].matchAll(/<c r="([A-Z]+)\d+"/g)].map((m) => m[1].padStart(3, ' '));
            assert.deepEqual(cols, [...cols].sort(), row[0].slice(0, 40));
        }

        // every other part keeps its bytes
        const before = new Map(readZip(input).map((e) => [e.name, e.raw]));
        for (const e of readZip(file)) {
            if (e.name !== 'xl/worksheets/sheet1.xml') assert.deepEqual(e.raw, before.get(e.name), e.name);
        }

        // grouping the answer again writes over the same columns and adds none
        const again = await groupXlsx(file, fakeGroup());
        assert.deepEqual(again.summary.addedFields, []);
        assert.equal(sheetOf(again.file), sheet);
    });

    test('a workbook with no PDX column, or a broken zip, is a FileFormatError', async () => {
        const none = buildXlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>HN</t></is></c></row>');
        await assert.rejects(groupXlsx(none, fakeGroup()), /no sheet has a PDX column/);
        await assert.rejects(groupXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), fakeGroup()), FileFormatError);
    });
});

describe('HTTP: the file endpoint takes every format', () => {
    let app;
    before(async () => {
        app = await buildApp({ apiKey: '', logLevel: 'silent', defaultVersion: '6.3.4', maxBatch: 10, maxFileRecords: 5, webUi: true }, fakeRunner());
    });
    after(() => app?.close());

    const post = (payload, type) => app.inject({ method: 'POST', url: '/api/v1/group/file', payload, headers: type ? { 'content-type': type } : {} });

    test('.csv in, .csv out', async () => {
        const res = await post('pdx,sex\nK35.8,1\n', 'text/csv');
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
        assert.match(res.headers['content-disposition'], /filename="grouped\.csv"/);
        const summary = JSON.parse(res.headers['x-grouper-summary']);
        assert.equal(summary.format, 'csv');
        assert.equal(summary.grouped, 1);
        assert.match(res.body, /^pdx,sex,DRG,/);
    });

    test('.json and .xlsx in, the same out', async () => {
        const json = await post([{ pdx: 'K35.8', sex: 1 }]);
        assert.equal(json.statusCode, 200);
        assert.match(json.headers['content-type'], /application\/json/);
        assert.equal(json.json()[0].result.drg, '06070');
        const xlsx = await post(buildXlsx(SHEET, { strings: STRINGS }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        assert.equal(xlsx.statusCode, 200);
        assert.match(xlsx.headers['content-disposition'], /grouped\.xlsx/);
        assert.equal(JSON.parse(xlsx.headers['x-grouper-summary']).sheet, 'IPD');
    });

    test('too many rows, an .xls file and junk are 400', async () => {
        const many = await post(`pdx\n${'K358\n'.repeat(6)}`, 'text/plain');
        assert.equal(many.statusCode, 400);
        assert.match(many.json().message, /at most 5/);
        assert.equal((await post(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/vnd.ms-excel')).statusCode, 400);
        assert.equal((await post({ a: 1 })).statusCode, 400);
        assert.equal((await post('')).statusCode, 400);
    });
});
