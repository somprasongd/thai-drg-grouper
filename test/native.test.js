// Tests of the grouper through the HTTP API. The expected answers are what TGrp6305.exe
// (Thai DRG 6.3.4) gives for the same cases. They need the TCMC files made by "npm run setup";
// without them the tests are skipped, or fail when REQUIRE_DATA=1 (as in CI).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadGroupers } from '../src/groupers.js';
import { buildApp } from '../src/app.js';
import { buildDbf, parseDbf } from '../src/dbf.js';
import { DRG_FIELDS } from '../src/layout.js';

const appendectomy = {
    ref: 'AN-001',
    sex: 1,
    dob: '1980-05-10',
    admitDate: '2024-01-10T08:30',
    dischargeDate: '2024-01-13T10:00',
    dischargeType: 1,
    pdx: 'K35.8',
    procedures: ['47.09'],
};

const adult = { sex: 1, dob: '1980-01-01', admitDate: '2024-10-01T08:00', dischargeDate: '2024-10-05T08:00', dischargeType: 1 };

const config = { ...loadConfig(), apiKey: '', logLevel: 'silent', maxBatch: 5000 };
const hasData = existsSync(join(config.groupersDir, '6.3.4', 'native', 'rules.json')) && existsSync(join(config.groupersDir, '6.3.4', 'c63i10.dbf'));
const skip = !hasData && process.env.REQUIRE_DATA !== '1' ? 'TCMC files not found: run npm run setup' : false;

describe('API with the grouper', { skip }, () => {
    let app;

    before(async () => {
        app = await buildApp(config, loadGroupers(config));
    });

    after(async () => {
        await app?.close();
    });

    const post = (url, payload) => app.inject({ method: 'POST', url, payload });
    const group = async (c) => (await post('/api/v1/group', c)).json();

    test('one case: appendectomy', async () => {
        const r = await group(appendectomy);
        assert.equal(r.version, '6.3.4');
        assert.equal(r.engine, 'native');
        assert.equal(r.ref, 'AN-001');
        assert.equal(r.drg, '06070');
        assert.equal(r.dc, '0607');
        assert.equal(r.drgName, 'Appendectomy wo sig CCC');
        assert.equal(r.rw, 1.2127);
        assert.equal(r.adjrw, 1.2127);
        assert.equal(r.wtlos, 3.05);
        assert.equal(r.ot, 9);
        assert.equal(r.los, 3);
        assert.equal(r.age, 43);
        assert.equal(r.errorCode, 0);
        assert.deepEqual(r.warnings, []);
    });

    test('newborn uses the admission weight', async () => {
        const r = await group({
            sex: 2, dob: '2024-03-01', admitDate: '2024-03-01T02:00', dischargeDate: '2024-03-04T10:00',
            dischargeType: 1, admitWeight: 1.9, pdx: 'P07.1', sdx: ['P22.0'],
        });
        assert.equal(r.drg, '15532');
        assert.equal(r.rw, 1.1989);
    });

    test('unknown diagnosis is ungroupable with error 2', async () => {
        const r = await group({ ...appendectomy, pdx: 'ZZZZ', procedures: [] });
        assert.equal(r.drg, '26509');
        assert.equal(r.errorCode, 2);
    });

    test('extension codes: two sites in one setting is a multiple craniotomy', async () => {
        assert.equal((await group({ ...adult, pdx: 'S02.81', procedures: ['01.25'] })).drg, '01010');
        assert.equal((await group({ ...adult, pdx: 'S02.81', procedures: ['01.25+21'] })).drg, '01129');
        assert.equal((await group({ ...adult, pdx: 'S02.81', procedures: ['01.25+11', '01.25+12'] })).drg, '01129');
        // settings must start at 1: +12 alone is cut back to 0125
        assert.equal((await group({ ...adult, pdx: 'S02.81', procedures: ['01.25+12'] })).drg, '01010');
    });

    test('reassignment by procedure and secondary diagnosis', async () => {
        const r = await group({ ...adult, pdx: 'J18.9', sdx: ['S02.81'], procedures: ['01.25'] });
        assert.equal(r.drg, '01011');
        assert.equal(r.pdxUsed, 'S0281');
    });

    test('a code of both genital MDCs needs the sex', async () => {
        const r = await group({
            dob: '1964-08-31', admitDate: '2024-07-31T12:09', dischargeDate: '2024-08-07T02:22', dischargeType: 1,
            pdx: 'Z12.0', sdx: ['C76.3'], procedures: ['42.51'],
        });
        assert.equal(r.errorCode, 7);
        assert.equal(r.drg, '26509');
    });

    test('batch keeps order and reports bad cases without stopping', async () => {
        const cases = Array.from({ length: 300 }, (_, i) => ({ ...appendectomy, ref: `AN-${i}` }));
        cases[7] = { ...appendectomy, ref: 'bad', admitDate: 'yesterday' };
        const body = (await post('/api/v1/group/batch', { cases })).json();
        assert.equal(body.grouped, 299);
        assert.equal(body.results[7].ok, false);
        body.results.forEach((r, i) => {
            assert.equal(r.index, i);
            if (i !== 7) assert.equal(r.drg, '06070');
        });
    });

    test('reference endpoints show the engine', async () => {
        const versions = (await app.inject('/api/v1/versions')).json();
        assert.deepEqual(versions.versions.map((v) => [v.version, v.engine]), [['6.3.4', 'native']]);
        const health = (await app.inject('/health')).json();
        assert.equal(health.groupers[0].engine, 'native');
        assert.equal(health.groupers[0].failures, 0);
    });

    test('an unknown version is a 400', async () => {
        const res = await post('/api/v1/group?version=6.2.1', appendectomy);
        assert.equal(res.statusCode, 400);
        assert.match(res.json().message, /unknown version/);
    });

    test('DRG look-up', async () => {
        const r = (await app.inject('/api/v1/drg/06070')).json();
        assert.equal(r.rw, 1.2127);
        assert.equal(r.rw0d, 1.1036);
        assert.equal(r.wtlos, 3.05);
        assert.equal(r.ot, 9);
        assert.equal((await app.inject('/api/v1/drg/99999')).statusCode, 404);
    });

    test('a .dbf file comes back grouped', async () => {
        const rec = {
            DOB: '1980-05-10', SEX: '1', DATEADM: '2024-01-10', TIMEADM: '0830', DATEDSC: '2024-01-13', TIMEDSC: '1000',
            DISCHT: '1', PDX: 'K358', PROC1: '4709',
        };
        const payload = buildDbf(DRG_FIELDS, [rec, { ...rec, PDX: 'Z000' }]);
        const res = await app.inject({ method: 'POST', url: '/api/v1/group/file', payload, headers: { 'content-type': 'application/octet-stream' } });
        assert.equal(res.statusCode, 200);
        const [a, b] = parseDbf(res.rawPayload).records;
        assert.equal(a.DRG, '06070');
        assert.equal(a.RW, 1.2127);
        assert.equal(a.WTLOS, 3.05);
        assert.equal(a.OT, 9);
        assert.equal(a.ACTLOS, 3);
        assert.equal(a.ERR, 0);
        assert.equal(b.ERR, 3, 'Z00.0 is not acceptable as PDx');
        const summary = JSON.parse(res.headers['x-grouper-summary']);
        assert.equal(summary.grouped, 2);
        assert.equal(summary.withError, 1);
    });

    test('API key', async () => {
        const locked = await buildApp({ ...config, apiKey: 'secret' }, loadGroupers(config));
        try {
            assert.equal((await locked.inject({ method: 'POST', url: '/api/v1/group', payload: appendectomy })).statusCode, 401);
            const ok = await locked.inject({ method: 'POST', url: '/api/v1/group', payload: appendectomy, headers: { 'x-api-key': 'secret' } });
            assert.equal(ok.json().drg, '06070');
            assert.equal((await locked.inject('/health')).statusCode, 200);
        } finally {
            await locked.close();
        }
    });
});

describe('loading', () => {
    test('a version folder without the TCMC files says to run setup', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tdrg-empty-'));
        try {
            mkdirSync(join(dir, '6.3.4'));
            writeFileSync(join(dir, '6.3.4', 'grouper.json'), JSON.stringify({ drgTable: 'c63drg.dbf' }));
            assert.throws(() => loadGroupers({ ...config, groupersDir: dir }), /npm run setup/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
