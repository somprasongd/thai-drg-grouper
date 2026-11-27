// Turns one JSON case into a record for the grouper's data file (see layout.js).
// Rules follow the TGrp6305 manual and what the Hospital-OS module (2.4.0) sends:
// dots are removed from ICD codes, ICD-10 is cut to 6 characters and ICD-9-CM to 7 (#1066),
// only the first 12 secondary diagnoses and 20 procedures are used.

import { MAX_PROC, MAX_SDX } from './layout.js';
import { DISCHARGE_TYPES } from './codes.js';

export class InputError extends Error {
    constructor(problems) {
        super(problems.join('; '));
        this.problems = problems;
    }
}

const DX_LEN = 6;
const PROC_LEN = 7;

function isRealDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "YYYY-MM-DD", "YYYYMMDD" or "YYYY-MM-DDTHH:mm[:ss]" → { date: 'YYYY-MM-DD', time: 'HHMM'|null } */
function parseDateTime(value, label, problems) {
    if (value === undefined || value === null || value === '') return { date: null, time: null };
    const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(String(value).trim());
    if (!m) {
        problems.push(`${label}: "${value}" is not a date (use YYYY-MM-DD)`);
        return { date: null, time: null };
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isRealDate(y, mo, d)) {
        problems.push(`${label}: "${value}" is not a real date`);
        return { date: null, time: null };
    }
    if (y > 2400) {
        problems.push(`${label}: "${value}" looks like a Buddhist-era year; send the Christian-era (ค.ศ.) year`);
        return { date: null, time: null };
    }
    let time = null;
    if (m[4] !== undefined) {
        time = checkTime(`${m[4]}${m[5]}`, label, problems);
    }
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time };
}

/** "HH:mm", "HHmm" or "HH:mm:ss" → "HHMM" */
function parseTime(value, label, problems) {
    if (value === undefined || value === null || value === '') return null;
    const m = /^(\d{1,2}):?(\d{2})(?::\d{2})?$/.exec(String(value).trim());
    if (!m) {
        problems.push(`${label}: "${value}" is not a time (use HH:mm)`);
        return null;
    }
    return checkTime(`${m[1].padStart(2, '0')}${m[2]}`, label, problems);
}

function checkTime(hhmm, label, problems) {
    const h = Number(hhmm.slice(0, 2));
    const mi = Number(hhmm.slice(2));
    if (h > 23 || mi > 59) {
        problems.push(`${label}: "${hhmm}" is not a valid time`);
        return null;
    }
    return hhmm;
}

function parseSex(value, problems) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim().toUpperCase();
    if (['1', 'M', 'MALE', 'ชาย'].includes(s)) return '1';
    if (['2', 'F', 'FEMALE', 'หญิง'].includes(s)) return '2';
    problems.push(`sex: "${value}" must be 1 (male) or 2 (female)`);
    return null;
}

function parseDischargeType(value, problems) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim();
    if (!(s in DISCHARGE_TYPES)) {
        problems.push(`dischargeType: "${value}" must be one of ${Object.keys(DISCHARGE_TYPES).join(', ')}`);
        return null;
    }
    return s;
}

function parseNumber(value, label, { min = 0, max, integer = false }, problems) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || (max !== undefined && n > max) || (integer && !Number.isInteger(n))) {
        problems.push(`${label}: "${value}" must be ${integer ? 'a whole number' : 'a number'} from ${min}${max !== undefined ? ` to ${max}` : ''}`);
        return null;
    }
    return n;
}

function cleanCode(raw, maxLen, pattern, label, problems, notes) {
    if (raw === undefined || raw === null) return '';
    const code = String(raw).replace(/[.\s]/g, '').toUpperCase();
    if (code === '') return '';
    if (!pattern.test(code)) {
        problems.push(`${label}: "${raw}" is not a valid code`);
        return '';
    }
    if (code.length > maxLen) {
        notes.push(`${label}: "${raw}" was cut to "${code.slice(0, maxLen)}" (${maxLen} characters)`);
        return code.slice(0, maxLen);
    }
    return code;
}

function codeList(value, label, problems) {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return value.split(/[,;\s]+/).filter(Boolean);
    if (!Array.isArray(value)) {
        problems.push(`${label}: must be an array of codes`);
        return [];
    }
    return value;
}

/** Whole years and the days since the last birthday, on the admission date. */
export function ageOn(dob, onDate) {
    const [by, bm, bd] = dob.split('-').map(Number);
    const [ay, am, ad] = onDate.split('-').map(Number);
    const at = Date.UTC(ay, am - 1, ad);
    if (at < Date.UTC(by, bm - 1, bd)) return null;
    let years = ay - by;
    let last = Date.UTC(by + years, bm - 1, bd);
    if (last > at) {
        years -= 1;
        last = Date.UTC(by + years, bm - 1, bd);
    }
    return { years, days: Math.round((at - last) / 86400000) };
}

/**
 * Validate and normalise one case.
 * @returns {{ record: object, notes: string[] }} record keyed by grouper field name
 * @throws {InputError}
 */
export function toGrouperRecord(input) {
    const problems = [];
    const notes = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new InputError(['case must be a JSON object']);
    }

    const dob = parseDateTime(input.dob, 'dob', problems).date;
    const adm = parseDateTime(input.admitDate, 'admitDate', problems);
    const dsc = parseDateTime(input.dischargeDate, 'dischargeDate', problems);
    const timeAdm = input.admitTime !== undefined ? parseTime(input.admitTime, 'admitTime', problems) : adm.time;
    const timeDsc = input.dischargeTime !== undefined ? parseTime(input.dischargeTime, 'dischargeTime', problems) : dsc.time;

    if (adm.date && dsc.date && dsc.date < adm.date) {
        problems.push('dischargeDate is before admitDate');
    }
    // The grouper needs the time as well as the date; without it LOS cannot be worked out
    // (error 9, warning 128/256). We do not invent a time, we only say why.
    if (adm.date && !timeAdm) notes.push('admitTime is missing: the grouper will report warning 128 and LOS error 9');
    if (dsc.date && !timeDsc) notes.push('dischargeTime is missing: the grouper will report warning 256 and LOS error 9');

    let age = parseNumber(input.age, 'age', { max: 124, integer: true }, problems);
    let ageDay = parseNumber(input.ageDay, 'ageDay', { max: 365, integer: true }, problems);
    if (dob && adm.date && (age === null || ageDay === null)) {
        const a = ageOn(dob, adm.date);
        if (a === null) {
            problems.push('dob is after admitDate');
        } else {
            if (age === null) age = a.years;
            if (ageDay === null) ageDay = a.days;
        }
    }

    const pdx = cleanCode(input.pdx, DX_LEN, /^[A-Z0-9]+$/, 'pdx', problems, notes);

    let sdx = codeList(input.sdx, 'sdx', problems)
        .map((c, i) => cleanCode(c, DX_LEN, /^[A-Z0-9]+$/, `sdx[${i}]`, problems, notes))
        .filter(Boolean);
    if (sdx.length > MAX_SDX) {
        notes.push(`sdx: only the first ${MAX_SDX} of ${sdx.length} codes were sent to the grouper`);
        sdx = sdx.slice(0, MAX_SDX);
    }

    let procs = codeList(input.procedures, 'procedures', problems)
        .map((c, i) => cleanCode(c, PROC_LEN, /^[A-Z0-9+]+$/, `procedures[${i}]`, problems, notes))
        .filter(Boolean);
    if (procs.length > MAX_PROC) {
        notes.push(`procedures: only the first ${MAX_PROC} of ${procs.length} codes were sent to the grouper`);
        procs = procs.slice(0, MAX_PROC);
    }

    const record = {
        DOB: dob,
        SEX: parseSex(input.sex, problems),
        DATEADM: adm.date,
        TIMEADM: timeAdm,
        DATEDSC: dsc.date,
        TIMEDSC: timeDsc,
        DISCHT: parseDischargeType(input.dischargeType, problems),
        ADMWT: parseNumber(input.admitWeight, 'admitWeight', { max: 999.999 }, problems),
        AGE: age === null ? null : String(age),
        AGEDAY: ageDay === null ? null : String(ageDay),
        PDX: pdx,
        LEAVEDAY: parseNumber(input.leaveDays ?? 0, 'leaveDays', { max: 999, integer: true }, problems),
    };
    sdx.forEach((c, i) => { record[`SDX${i + 1}`] = c; });
    procs.forEach((c, i) => { record[`PROC${i + 1}`] = c; });

    if (problems.length) throw new InputError(problems);
    return { record, notes };
}
