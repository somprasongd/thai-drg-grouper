// Tests that do not need the grouper exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDbf, parseDbf } from '../src/dbf.js';
import { DRG_FIELDS } from '../src/layout.js';
import { InputError, ageOn, toGrouperRecord } from '../src/input.js';
import { describeError, describeWarnings } from '../src/codes.js';

const base = {
    sex: 1,
    dob: '1980-05-10',
    admitDate: '2024-01-10T08:30',
    dischargeDate: '2024-01-13T10:00',
    dischargeType: 1,
    pdx: 'K35.8',
};

test('dbf: what is written is read back', () => {
    const rec = {
        DOB: '1980-05-10', SEX: '1', DATEADM: '2024-01-10', TIMEADM: '0830', ADMWT: 1.9,
        PDX: 'K358', SDX1: 'E119', PROC1: '4709', LEAVEDAY: 0,
    };
    const { fields, records } = parseDbf(buildDbf(DRG_FIELDS, [rec, rec]));
    assert.equal(fields.length, DRG_FIELDS.length);
    assert.equal(records.length, 2);
    assert.equal(records[1].DOB, '1980-05-10');
    assert.equal(records[1].TIMEADM, '0830');
    assert.equal(records[1].ADMWT, 1.9);
    assert.equal(records[1].PDX, 'K358');
    assert.equal(records[1].PROC1, '4709');
    assert.equal(records[1].DRG, '');
    assert.equal(records[1].RW, null);
});

test('input: dates, times, codes and age are normalised', () => {
    const { record, notes } = toGrouperRecord({ ...base, sdx: 'E11.9, N18.5', procedures: ['47.09'] });
    assert.equal(record.DATEADM, '2024-01-10');
    assert.equal(record.TIMEADM, '0830');
    assert.equal(record.TIMEDSC, '1000');
    assert.equal(record.PDX, 'K358');
    assert.equal(record.SDX1, 'E119');
    assert.equal(record.SDX2, 'N185');
    assert.equal(record.PROC1, '4709');
    assert.equal(record.AGE, '43');
    assert.equal(record.AGEDAY, '245');
    assert.equal(record.LEAVEDAY, 0);
    assert.deepEqual(notes, []);
});

test('input: separate time fields and other spellings are accepted', () => {
    const { record } = toGrouperRecord({
        ...base, sex: 'F', admitDate: '20240110', admitTime: '8:30', dischargeDate: '2024-01-13', dischargeTime: '1000',
    });
    assert.equal(record.SEX, '2');
    assert.equal(record.DATEADM, '2024-01-10');
    assert.equal(record.TIMEADM, '0830');
    assert.equal(record.TIMEDSC, '1000');
});

test('input: missing times give notes, not errors', () => {
    const { record, notes } = toGrouperRecord({ ...base, admitDate: '2024-01-10', dischargeDate: '2024-01-13' });
    assert.equal(record.TIMEADM, null);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /warning 128/);
});

test('input: long codes are cut and extra codes dropped, with notes', () => {
    const sdx = Array.from({ length: 14 }, (_, i) => `E11${i % 10}`);
    const { record, notes } = toGrouperRecord({ ...base, pdx: 'S7200123', sdx });
    assert.equal(record.PDX, 'S72001');
    assert.equal(record.SDX12, 'E111');
    assert.equal(record.SDX13, undefined);
    assert.equal(notes.length, 2);
});

test('input: bad values are all reported together', () => {
    assert.throws(
        () => toGrouperRecord({ ...base, sex: 3, dob: '2567-01-01', dischargeType: 7, pdx: 'K35-8' }),
        (e) => e instanceof InputError && e.problems.length === 4,
    );
    assert.throws(() => toGrouperRecord({ ...base, admitDate: '2024-02-30' }), InputError);
    assert.throws(() => toGrouperRecord({ ...base, dischargeDate: '2024-01-09' }), /before admitDate/);
    assert.throws(() => toGrouperRecord({ ...base, dob: '2025-01-01' }), /after admitDate/);
});

test('ageOn: years and days since the last birthday', () => {
    assert.deepEqual(ageOn('1980-05-10', '2024-01-10'), { years: 43, days: 245 });
    assert.deepEqual(ageOn('2024-03-01', '2024-03-01'), { years: 0, days: 0 });
    assert.deepEqual(ageOn('2000-01-10', '2024-01-10'), { years: 24, days: 0 });
    assert.equal(ageOn('2024-03-02', '2024-03-01'), null);
});

test('codes: error and warning descriptions', () => {
    assert.equal(describeError(0), null);
    assert.equal(describeError(2).message, 'Invalid principal diagnosis');
    assert.deepEqual(describeWarnings(384).map((w) => w.code), [128, 256]);
    assert.deepEqual(describeWarnings(512).map((w) => w.code), [512]);
});
