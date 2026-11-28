// The .dbf file endpoint and the web UI, with a stand-in grouper (no TCMC files needed).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDbf, parseDbf, readDbfHeader } from '../src/dbf.js';
import { DRG_FIELDS } from '../src/layout.js';
import { groupDbf, RESULT_FIELDS } from '../src/dbffile.js';
import { buildApp } from '../src/app.js';

const RESULT_NAMES = new Set(RESULT_FIELDS.map((f) => f.name));
const INPUT_ONLY = DRG_FIELDS.filter((f) => !RESULT_NAMES.has(f.name));

// "สมชาย ใจดี" in TIS-620 (Thai code page 874)
const THAI_NAME = Buffer.from([0xca, 0xc1, 0xa8, 0xd2, 0xc2, 0x20, 0xe3, 0xa8, 0xb4, 0xd5]);

const appendectomy = {
    DOB: '1980-05-10', SEX: '1', DATEADM: '2024-01-10', TIMEADM: '0830', DATEDSC: '2024-01-13', TIMEDSC: '1000',
    DISCHT: '1', PDX: 'K358', PROC1: '4709', LEAVEDAY: 0,
};

/** a stand-in grouper: the DRG comes from the PDX so the tests can tell records apart */
function fakeRunner() {
    const seen = [];
    const group = async (version, records) => {
        seen.push(...records);
        return records.map((r) => (r.PDX === 'BAD'
            ? { DRG: '26509', MDC: '26', ERR: 2, WARN: 0, RW: 0, ADJRW: 0, WTLOS: 0, OT: 0, ACTLOS: 3 }
            : { DRG: '06070', MDC: '06', ERR: 0, WARN: r.SEX ? 0 : 32, RW: 1.2127, ADJRW: 1.2127, WTLOS: 3.05, OT: 9, ACTLOS: 3 }));
    };
    const versions = new Map([['6.3.4', {
        version: '6.3.4', engine: 'native', name: 'Thai DRG 6.3.4', drgTable: new Map(),
        stats: { runs: 0, cases: 0, failures: 0, totalMs: 0 },
    }]]);
    return { versions, group, queued: 0, seen };
}

/** grouper file with an HN column and a Thai name column, the 3rd record deleted */
function sampleFile(fields = DRG_FIELDS) {
    const all = [{ name: 'HN', type: 'C', length: 9 }, ...fields, { name: 'PTNAME', type: 'C', length: 20 }];
    const rows = [
        { ...appendectomy, HN: '000000001' },
        { ...appendectomy, HN: '000000002', PDX: 'BAD' },
        { ...appendectomy, HN: '000000003' },
        { ...appendectomy, HN: '000000004', SEX: '' },
    ];
    const buf = buildDbf(all, rows);
    const h = readDbfHeader(buf);
    const name = h.fields.find((f) => f.name === 'PTNAME');
    for (let r = 0; r < rows.length; r++) THAI_NAME.copy(buf, h.headerLength + r * h.recordLength + name.offset);
    buf[h.headerLength + 2 * h.recordLength] = 0x2a; // deleted
    return buf;
}

const fieldBytes = (buf, r, name) => {
    const h = readDbfHeader(buf);
    const f = h.fields.find((x) => x.name === name);
    const start = h.headerLength + r * h.recordLength + f.offset;
    return buf.subarray(start, start + f.length);
};

test('dbf header: offsets, and broken files are refused', () => {
    const h = readDbfHeader(buildDbf(DRG_FIELDS, [appendectomy]));
    assert.equal(h.count, 1);
    assert.equal(h.fields[0].offset, 1);
    assert.equal(h.fields[1].offset, 9);
    assert.throws(() => readDbfHeader(Buffer.from('hello world')), /too short/);
    assert.throws(() => readDbfHeader(Buffer.alloc(200, 0x41)), /bad header|bad field|no field/);
    const cut = buildDbf(DRG_FIELDS, [appendectomy, appendectomy]);
    assert.throws(() => readDbfHeader(cut.subarray(0, cut.length - 300)), /cut short/);
});

test('groupDbf: results go into the file, every other byte stays', async () => {
    const input = sampleFile();
    const before = Buffer.from(input);
    const runner = fakeRunner();
    const { file, summary } = await groupDbf(input, (recs) => runner.group('6.3.4', recs));

    assert.deepEqual(input, before, 'the input buffer is not changed');
    assert.equal(file.length, input.length);
    const h = readDbfHeader(file);
    const resultRanges = h.fields.filter((f) => RESULT_NAMES.has(f.name));
    for (let i = 0; i < file.length; i++) {
        if (i < h.headerLength) {
            assert.equal(file[i], input[i], `header byte ${i}`);
            continue;
        }
        const r = Math.floor((i - h.headerLength) / h.recordLength);
        const at = (i - h.headerLength) % h.recordLength;
        const inResult = r < h.count && r !== 2 && resultRanges.some((f) => at >= f.offset && at < f.offset + f.length);
        if (!inResult) assert.equal(file[i], input[i], `byte ${i} (record ${r}, offset ${at})`);
    }
    assert.deepEqual(fieldBytes(file, 0, 'PTNAME').subarray(0, THAI_NAME.length), THAI_NAME);
    assert.equal(file[file.length - 1], 0x1a);

    const rows = parseDbf(file).records; // deleted record left out
    assert.equal(rows.length, 3);
    assert.equal(rows[0].HN, '000000001');
    assert.equal(rows[0].DRG, '06070');
    assert.equal(rows[0].MDC, '06');
    assert.equal(rows[0].RW, 1.2127);
    assert.equal(rows[0].ADJRW, 1.2127);
    assert.equal(rows[0].WTLOS, 3.05);
    assert.equal(rows[0].OT, 9);
    assert.equal(rows[0].ACTLOS, 3);
    assert.equal(rows[0].ERR, 0);
    assert.equal(rows[1].DRG, '26509');
    assert.equal(rows[1].ERR, 2);
    assert.equal(rows[2].WARN, 32);
    assert.equal(fieldBytes(file, 0, 'RW').toString('latin1'), ' 1.2127');
    assert.equal(fieldBytes(file, 2, 'DRG').toString('latin1'), '     ', 'deleted record not touched');

    assert.equal(runner.seen.length, 3);
    assert.equal(runner.seen[0].DATEADM, '2024-01-10');
    assert.equal(runner.seen[0].TIMEADM, '0830');
    assert.equal(runner.seen[0].PROC1, '4709');
    assert.equal(runner.seen[0].HN, undefined, 'only the grouper fields go to the grouper');
    assert.deepEqual(summary, {
        records: 4, grouped: 3, deleted: 1, withError: 1, withWarning: 1, errors: { 2: 1 },
        overflow: 0, sumAdjRw: 2.4254, cmi: 0.8085, addedFields: [],
    });
});

test('groupDbf: a file without result fields gets them added', async () => {
    const input = sampleFile(INPUT_ONLY);
    const { file, summary } = await groupDbf(input, (recs) => fakeRunner().group('6.3.4', recs));
    assert.deepEqual(summary.addedFields, ['ACTLOS', 'DRG', 'MDC', 'ERR', 'WARN', 'RW', 'OT', 'WTLOS', 'ADJRW']);
    const h = readDbfHeader(file);
    const old = readDbfHeader(input);
    assert.equal(h.fields.length, old.fields.length + 9);
    assert.equal(h.recordLength, old.recordLength + RESULT_FIELDS.reduce((s, f) => s + f.length, 0));
    for (let r = 0; r < h.count; r++) {
        const a = file.subarray(h.headerLength + r * h.recordLength, h.headerLength + r * h.recordLength + old.recordLength);
        const b = input.subarray(old.headerLength + r * old.recordLength, old.headerLength + (r + 1) * old.recordLength);
        assert.deepEqual(a, b, `record ${r} keeps its bytes`);
    }
    const rows = parseDbf(file).records;
    assert.equal(rows[0].DRG, '06070');
    assert.equal(rows[0].ADJRW, 1.2127);
    assert.equal(rows[0].PTNAME, THAI_NAME.toString('latin1'));
});

test('groupDbf: too wide values are stars; bad files are refused', async () => {
    const narrow = INPUT_ONLY.concat([{ name: 'DRG', type: 'C', length: 3 }, { name: 'RW', type: 'N', length: 5, decimals: 4 }]);
    const { file, summary } = await groupDbf(buildDbf(narrow, [appendectomy]), (recs) => fakeRunner().group('6.3.4', recs));
    assert.equal(fieldBytes(file, 0, 'DRG').toString('latin1'), '***');
    assert.equal(fieldBytes(file, 0, 'RW').toString('latin1'), '*****');
    assert.equal(summary.overflow, 2);

    await assert.rejects(groupDbf(buildDbf([{ name: 'HN', type: 'C', length: 9 }], [{ HN: '1' }]), async () => []), /no PDX field/);
    await assert.rejects(groupDbf(buildDbf(INPUT_ONLY.concat([{ name: 'DRG', type: 'D', length: 8 }]), [appendectomy]), async () => []), /type D/);
    await assert.rejects(groupDbf(buildDbf(DRG_FIELDS, [appendectomy, appendectomy]), async () => [], { maxRecords: 1 }), /at most 1/);
});

describe('HTTP: file endpoint and web UI', () => {
    let app;
    const config = { apiKey: '', logLevel: 'silent', defaultVersion: '6.3.4', maxBatch: 5000, maxFileRecords: 100000, webUi: true };

    before(async () => {
        app = await buildApp(config, fakeRunner());
    });
    after(async () => app?.close());

    test('POST /api/v1/group/file sends the file back with a summary', async () => {
        const input = sampleFile();
        const res = await app.inject({ method: 'POST', url: '/api/v1/group/file', payload: input, headers: { 'content-type': 'application/octet-stream' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/octet-stream');
        assert.match(res.headers['content-disposition'], /attachment/);
        assert.equal(res.headers['cache-control'], 'no-store');
        const summary = JSON.parse(res.headers['x-grouper-summary']);
        assert.equal(summary.version, '6.3.4');
        assert.equal(summary.grouped, 3);
        assert.equal(res.rawPayload.length, input.length);
        assert.equal(parseDbf(res.rawPayload).records[0].DRG, '06070');
    });

    test('bad uploads are 4xx', async () => {
        const junk = await app.inject({ method: 'POST', url: '/api/v1/group/file', payload: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]), headers: { 'content-type': 'application/octet-stream' } });
        assert.equal(junk.statusCode, 400);
        assert.match(junk.json().message, /not a .dbf, .csv/);
        const cut = await app.inject({ method: 'POST', url: '/api/v1/group/file', payload: sampleFile().subarray(0, 600), headers: { 'content-type': 'application/octet-stream' } });
        assert.equal(cut.statusCode, 400);
        assert.match(cut.json().message, /dbf|cut short/);
        const json = await app.inject({ method: 'POST', url: '/api/v1/group/file', payload: { a: 1 } });
        assert.equal(json.statusCode, 400);
        const version = await app.inject({ method: 'POST', url: '/api/v1/group/file?version=9.9', payload: sampleFile(), headers: { 'content-type': 'application/octet-stream' } });
        assert.equal(version.statusCode, 400);
    });

    test('the web UI is served with a strict CSP', async () => {
        const page = await app.inject('/');
        assert.equal(page.statusCode, 200);
        assert.match(page.headers['content-type'], /text\/html/);
        assert.match(page.headers['content-security-policy'], /default-src 'none'/);
        assert.equal(page.headers['x-frame-options'], 'DENY');
        assert.match(page.body, /Thai DRG Grouper/);
        for (const path of ['/ui/app.js', '/ui/app.css', '/ui/icon.svg']) {
            assert.equal((await app.inject(path)).statusCode, 200, path);
        }
        assert.equal((await app.inject('/ui/../package.json')).statusCode, 404);
    });

    test('WEB_UI=off leaves the UI out; the API key guards the file endpoint', async () => {
        const locked = await buildApp({ ...config, webUi: false, apiKey: 'secret' }, fakeRunner());
        try {
            assert.equal((await locked.inject('/')).statusCode, 404);
            const body = sampleFile();
            const headers = { 'content-type': 'application/octet-stream' };
            assert.equal((await locked.inject({ method: 'POST', url: '/api/v1/group/file', payload: body, headers })).statusCode, 401);
            const ok = await locked.inject({ method: 'POST', url: '/api/v1/group/file', payload: body, headers: { ...headers, 'x-api-key': 'secret' } });
            assert.equal(ok.statusCode, 200);
        } finally {
            await locked.close();
        }
    });
});
