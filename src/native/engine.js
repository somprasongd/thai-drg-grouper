// Native Thai DRG grouper: a JavaScript implementation of the grouping logic described in the
// TCMC books "Thai DRG version 6.3.3" (book 1: rules and appendices, book 2: MDC definitions)
// using the 6.3.4 tables that the grouper ships (c63i10, c63proc, c63drg, c63ccex).
//
// The engine was written from the books only; TGrp6305.exe is used as a black box to compare
// results (tools/compare.mjs). Where the books leave a choice open, the comments say what was
// chosen and the comparison is what decided it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDbfFile } from '../dbf.js';
import { compileDc, NeedError } from './conditions.js';

const VALID_DISCHT = new Set(['1', '2', '3', '4', '5', '8', '9']);
const MINUTES_PER_DAY = 1440;

/** DRGs of the DCs of MDC 26 that book 2 does not list as "DC and DRG Definition" (book 1, ch. 4). */
const MDC26 = {
    2601: [['26010', 0, 1], ['26011', 2, 2], ['26012', 3, 9]],
    2602: [['26020', 0, 3], ['26021', 4, 6], ['26022', 7, 9]],
    2603: [['26030', 0, 1], ['26031', 2, 2], ['26032', 3, 9]],
    2604: [['26040', 0, 1], ['26041', 2, 9]],
    2605: [['26050', 0, 3], ['26051', 4, 9]],
    2611: [['26119', null, null]],
    2612: [['26120', 0, 1], ['26121', 2, 9]],
    2613: [['26130', 0, 1], ['26131', 2, 9]],
    2614: [['26149', null, null]],
};

/** Ungroupable DRGs (book 1, ch. 5). */
const DRG_ERROR = { 3: '26519', 6: '26539' };
const DRG_ERROR_DEFAULT = '26509';

/** b12 / b23 of Appendix H. */
const B = { M1: [0.077, 0.048], M2: [0.1212, 0.0743], P1: [0.0904, 0.0584], P2: [0.158, 0.1268] };

const trim = (v) => (v === undefined || v === null ? '' : String(v).trim());
const round4 = (x) => Math.round(x * 10000 + 1e-9) / 10000;

/** 'YYYY-MM-DD' (or Date) + 'HHMM' → minutes since epoch, or null. */
function toMinutes(date, time) {
    if (!date) return { ok: false, minutes: null };
    let y, m, d;
    if (date instanceof Date) [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    else {
        const mm = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(trim(date));
        if (!mm) return { ok: false, minutes: null };
        [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
    }
    const day = Date.UTC(y, m - 1, d);
    const back = new Date(day);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return { ok: false, minutes: null };
    const t = trim(time);
    const tm = /^(\d{2})(\d{2})$/.exec(t);
    if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return { ok: false, minutes: null, day };
    return { ok: true, minutes: day / 60000 + Number(tm[1]) * 60 + Number(tm[2]), day };
}

function dateParts(date) {
    if (!date) return null;
    if (date instanceof Date) return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(trim(date));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whole years and days since the last birthday. */
function ageFromDates(dob, adm) {
    const b = dateParts(dob);
    const a = dateParts(adm);
    if (!b || !a) return null;
    const at = Date.UTC(a[0], a[1] - 1, a[2]);
    if (at < Date.UTC(b[0], b[1] - 1, b[2])) return null;
    let years = a[0] - b[0];
    let last = Date.UTC(b[0] + years, b[1] - 1, b[2]);
    if (last > at) {
        years -= 1;
        last = Date.UTC(b[0] + years, b[1] - 1, b[2]);
    }
    return { years, days: Math.round((at - last) / 86400000), totalDays: Math.round((at - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000) };
}

function numberOrNull(v) {
    if (v === undefined || v === null || trim(v) === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** "lo-hi" holds codes >= lo and (<= hi or starting with hi). */
function inRange(code, range) {
    const [lo, hi] = range.split('-');
    if (hi === undefined) return code.startsWith(lo);
    return code >= lo && (code <= hi || code.startsWith(hi));
}

class Stop extends Error {
    constructor(err) {
        super(`grouper error ${err}`);
        this.err = err;
    }
}

/** MDCs whose diagrams in book 2 carry the unrelated OR procedure (UORP) branch. */
const UORP_MDCS = new Set(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '16', '17', '21']);

export class NativeGrouper {
    /** @param {string} dir the version folder (groupers/6.3.4) with the dbf tables and native/ */
    constructor(dir) {
        this.dir = dir;
        const rules = JSON.parse(readFileSync(join(dir, 'native', 'rules.json'), 'utf8'));
        const flow = JSON.parse(readFileSync(join(dir, 'native', 'flow.json'), 'utf8'));
        this.source = rules.source;

        this.dx = new Map();
        for (const r of readDbfFile(join(dir, 'c63i10.dbf')).records) {
            const row = {
                code: trim(r.CODE), mdc: trim(r.MDC), pdc: trim(r.PDC), cc: !!r.CC, mainCc: trim(r.MAINCC) || trim(r.CODE),
                dclMain: trim(r.DCLMAIN) || trim(r.CODE), hivAx: trim(r.HIV_AX), trauma: trim(r.TRAUMA), sex: trim(r.SEX) || 'B',
                accPdx: trim(r.ACCPDX) !== 'N', agedUse: trim(r.AGEDUSE) === 'Y', ageMin: r.AGEMIN ?? 0, ageMax: r.AGEMAX ?? 124,
                agedMin: r.AGEDMIN ?? 0, mosDx: r.MOSDX === 1,
            };
            if (!this.dx.has(row.code)) this.dx.set(row.code, []);
            this.dx.get(row.code).push(row);
        }

        this.proc = new Map();
        const combos = {};
        for (const r of readDbfFile(join(dir, 'c63proc.dbf')).records) {
            const code = trim(r.CODE);
            // a combination code (ORP C) stands for two procedures done together: DESC is "3844 & 3845"
            const both = trim(r.ORP) === 'C' && /^(\S+) & (\S+)$/.exec(trim(r.DESC));
            if (both) combos[code] = [both[1], both[2]];
            this.proc.set(code, {
                code, orp: trim(r.ORP), sex: trim(r.SEX) || 'B', site: trim(r.SITE), group: r.PROCGR ?? 0, level: r.PROCLEV ?? 0,
                extType: trim(r.EXTTYPE), mmdc: trim(r.MMDC), omdcs: trim(r.OMDCS).split(',').map((s) => s.trim()).filter(Boolean),
                mosProc: r.MOSPROC === 1, mosDc: trim(r.MOSDC), mosHier: Number(trim(r.MOSHIERAR)) || 99,
            });
        }

        this.drg = new Map();
        for (const r of readDbfFile(join(dir, 'c63drg.dbf')).records) {
            const drg = trim(r.DRG);
            if (drg) this.drg.set(drg, { drg, mdc: trim(r.MDC), dc: trim(r.DC), rw: r.RW ?? 0, rw0d: r.RW0D ?? 0, wtlos: r.WTLOS ?? 0, ot: r.OT ?? 0, of: r.MDF ?? 1, name: trim(r.DRGNAME) });
        }

        this.ccex = new Map();
        for (const r of readDbfFile(join(dir, 'c63ccex.dbf')).records) {
            const cc = trim(r.CC10);
            if (!this.ccex.has(cc)) this.ccex.set(cc, new Set());
            this.ccex.get(cc).add(trim(r.NOTFOR10));
        }

        this.dclText = rules.dcl;
        this.dclCache = new Map();
        this.dxPdc = rules.dxPdc;
        this.procPdc = rules.procPdc;
        this.ax = new Map(Object.entries(rules.ax).map(([k, v]) => [k, new Set(v.codes)]));
        this.dagger = new Map(rules.dagger.map(([dg, ast, use, mdc]) => [`${dg}|${ast}`, { use, mdc }]));
        this.combos = Object.entries({ ...rules.combos, ...combos });

        this.dcs = new Map();
        for (const d of rules.dcs) {
            if (!d.drgs.length) continue; // e.g. the prose of the 1452 note that sits under a DC heading
            this.dcs.set(d.dc, { dc: d.dc, name: d.name, test: compileDc(d.cond), drgs: d.drgs });
        }
        for (const [dc, list] of Object.entries(MDC26)) {
            this.dcs.set(dc, { dc, name: '', test: () => false, drgs: list.map(([drg, lo, hi]) => ({ drg, lo, hi })) });
        }
        // a DC that the diagram reaches on two branches, each with its own condition
        for (const [key, [dc, ...cond]] of Object.entries(flow.alias ?? {})) {
            if (key === 'about') continue;
            this.dcs.set(key, { dc, name: this.dcs.get(dc).name, test: compileDc(cond), drgs: this.dcs.get(dc).drgs });
        }
        this.flow = Object.fromEntries(Object.entries(flow.order).map(([k, v]) => [k, v.split(/\s+/)]));
        this.branch = Object.fromEntries(Object.entries(flow.branch ?? {}).filter(([k]) => k !== 'about').map(([k, [cond, order]]) => [k, { test: compileDc([cond]), order: order.split(/\s+/) }]));
        this.obstetric = Object.fromEntries(Object.entries(flow.obstetricReassignment).filter(([k]) => k !== 'about').map(([k, v]) => [k, v.split(/\s+/)]));
    }

    // ------------------------------------------------------------------ table lookups

    dcl(code, dc) {
        const row = this.dx.get(code)?.[0];
        const key = this.dclText[code] !== undefined ? code : row?.dclMain;
        if (!key || this.dclText[key] === undefined) return 0;
        let m = this.dclCache.get(key);
        if (!m) {
            m = new Map(this.dclText[key].split(' ').map((s) => [s.slice(0, 4), Number(s.slice(4))]));
            this.dclCache.set(key, m);
        }
        return m.get(dc) ?? 0;
    }

    /** Is code j excluded as a complication by the pivot code? (Appendix F2) */
    excluded(j, pivot) {
        const row = this.dx.get(j)?.[0];
        const set = this.ccex.get(row?.mainCc ?? j) ?? this.ccex.get(j);
        if (!set) return false;
        return set.has(pivot) || set.has(this.dx.get(pivot)?.[0]?.mainCc);
    }

    pcl(dc, dxs) {
        const items = dxs.map((code) => ({ code, l: this.dcl(code, dc) })).filter((x) => x.l > 0);
        items.sort((a, b) => b.l - a.l || (a.code < b.code ? 1 : a.code > b.code ? -1 : 0));
        for (let i = 0; i < items.length; i++) {
            if (items[i].l === 0) continue;
            for (let j = i + 1; j < items.length; j++) {
                if (items[j].l > 0 && this.excluded(items[j].code, items[i].code)) items[j].l = 0;
            }
        }
        let sum = 0;
        let k = 0;
        for (const x of items) {
            if (x.l === 0) continue;
            sum += x.l * 0.82 ** k;
            k++;
        }
        return Math.min(9, Math.floor(sum + 0.5 + 1e-9));
    }

    /** The c63i10 row that applies to a sex ('1' male, '2' female, null unknown). */
    dxRow(code, sex) {
        const rows = this.dx.get(code);
        if (!rows) return null;
        if (rows.length === 1) return rows[0];
        const want = sex === '1' ? 'M' : sex === '2' ? 'F' : null;
        // a code of both genital MDCs has two rows of sex B: MDC 12 for males, 13 for females
        const genital = sex === '1' ? '12' : sex === '2' ? '13' : null;
        return rows.find((r) => r.sex === want) ?? rows.find((r) => r.mdc === genital) ?? rows[0];
    }

    // ------------------------------------------------------------------ validation (book 1, ch. 5)

    ageConflict(row, age) {
        if (age.years < row.ageMin || age.years > row.ageMax) return true;
        if (row.agedUse && age.totalDays < row.agedMin) return true;
        return false;
    }

    sexConflict(rows, sex) {
        const sexes = new Set(rows.map((r) => r.sex));
        if (sexes.has('B') || (sexes.has('M') && sexes.has('F'))) return false;
        if (!sex) return true;
        return !sexes.has(sex === '1' ? 'M' : 'F');
    }

    /**
     * Group one record (the grouper's data-file fields, as toGrouperRecord makes them).
     * @returns {{DRG:string, MDC:string, ERR:number, WARN:number, RW:number, ADJRW:number, WTLOS:number, OT:number, ACTLOS:number|null, DC:string|null, PCL:number|null}}
     */
    group(rec) {
        let warn = 0;
        const addWarn = (w) => { warn |= w; };
        const errors = [];

        // sex
        const sexRaw = trim(rec.SEX);
        const sex = sexRaw === '1' || sexRaw === '2' ? sexRaw : null;
        if (!sex) addWarn(32);

        // discharge type
        const dischRaw = trim(rec.DISCHT);
        const dischOk = VALID_DISCHT.has(dischRaw);
        if (!dischOk) addWarn(64);

        // LOS
        const adm = toMinutes(rec.DATEADM, rec.TIMEADM);
        const dsc = toMinutes(rec.DATEDSC, rec.TIMEDSC);
        if (!adm.ok) addWarn(128);
        if (!dsc.ok) addWarn(256);
        const leave = numberOrNull(rec.LEAVEDAY) ?? 0;
        let los = null;
        let losMinutes = null;
        if (!adm.ok || !dsc.ok || leave < 0) errors.push(9);
        else {
            // The days of the stay are counted first (a remainder over 6 hours is a day), then the
            // leave days come off; only a negative result is an error (checked against the exe).
            const stay = dsc.minutes - adm.minutes;
            if (stay < 0) errors.push(9);
            else {
                los = Math.floor(stay / MINUTES_PER_DAY) + (stay % MINUTES_PER_DAY > 360 ? 1 : 0) - leave;
                losMinutes = stay - leave * MINUTES_PER_DAY;
                if (los < 0) { errors.push(9); los = null; }
            }
        }

        // age: the dates win over the AGE field
        let age = ageFromDates(rec.DOB, rec.DATEADM);
        if (!age) {
            const y = numberOrNull(rec.AGE);
            const dd = numberOrNull(rec.AGEDAY);
            if (y !== null && Number.isInteger(y)) {
                age = { years: y, days: dd ?? 0, totalDays: y === 0 ? (dd ?? null) : y * 365 + (dd ?? 0) };
                if (y === 0 && dd === null) age = null;
            }
        }
        if (!age || age.years < 0 || age.years > 124 || age.totalDays === null) {
            errors.push(6);
            age = null;
        }

        // admission weight
        let admWt = numberOrNull(rec.ADMWT);
        if (admWt !== null && admWt <= 0) admWt = null;
        if (age && age.totalDays < 28 && (admWt === null || admWt < 0.3)) errors.push(10);
        // a weight under 0.3 kg is no weight: an error for a newborn, and after 27 days the
        // MDC 15 rules read it as "wo AdmWt" (checked against the exe)
        if (admWt !== null && admWt < 0.3) admWt = null;

        // principal diagnosis
        const pdxIn = trim(rec.PDX);
        let pdxRows = null;
        if (!pdxIn) errors.push(1);
        else if (/^[VWXY]/.test(pdxIn) || !this.dx.has(pdxIn)) errors.push(2);
        else {
            pdxRows = this.dx.get(pdxIn);
            const row = this.dxRow(pdxIn, sex);
            if (!row.accPdx) errors.push(3);
            if (age && this.ageConflict(row, age)) errors.push(4);
            if (this.sexConflict(pdxRows, sex)) errors.push(sex ? 5 : 7);
        }

        // secondary diagnoses
        const sdx = [];
        const seen = new Set(pdxIn ? [pdxIn] : []);
        for (let i = 1; i <= 12; i++) {
            const code = trim(rec[`SDX${i}`]);
            if (!code) continue;
            if (/^[VWXY]/.test(code)) continue;
            if (!this.dx.has(code)) { addWarn(1); continue; }
            // a repeated code is checked for age and sex as well before it is dropped (exe)
            const rows = this.dx.get(code);
            const badAge = !!age && this.ageConflict(this.dxRow(code, sex), age);
            const badSex = this.sexConflict(rows, sex);
            if (badAge) addWarn(2);
            if (badSex) addWarn(4);
            if (seen.has(code)) { addWarn(1); continue; }
            // a code refused for age or sex is not remembered, so it is not a repeat later (exe)
            if (badAge || badSex) continue;
            seen.add(code);
            sdx.push(code);
        }

        // procedures and extension codes
        const procs = this.procedures(rec, sex, addWarn);

        const base = { WARN: warn, ACTLOS: los, DC: null, PCL: null };
        if (errors.length) return this.result({ ...base, err: Math.min(...errors) }, null, los, losMinutes);

        // dagger / asterisk: the asterisk code is grouped as PDx (Appendix A1)
        let pdx = pdxIn;
        let pdxMdc = null;
        if (sdx.length) {
            const pair = this.dagger.get(`${pdx}|${sdx[0]}`);
            if (pair && pair.use === sdx[0]) {
                sdx[0] = pdx;
                pdx = pair.use;
                pdxMdc = pair.mdc;
            }
        }

        const c = this.caseContext({ pdx, pdxMdc, sdx, procs, sex, age, los, admWt, dischOk, dischRaw });
        let dc;
        try {
            dc = this.findDc(c);
        } catch (e) {
            if (e instanceof NeedError || e instanceof Stop) return this.result({ ...base, err: e.err }, null, los, losMinutes);
            throw e;
        }
        if (!dc) return this.result({ ...base, err: 0, drg: DRG_ERROR_DEFAULT }, null, los, losMinutes);

        const def = this.dcs.get(dc);
        const pcl = this.pcl(dc, [c.pdx, ...c.sdx]);
        const hit = def.drgs.find((d) => d.lo === null || (pcl >= d.lo && pcl <= d.hi)) ?? def.drgs[def.drgs.length - 1];
        return this.result({ ...base, err: 0, drg: hit.drg, DC: dc, PCL: hit.lo === null ? null : pcl }, c, los, losMinutes);
    }

    procedures(rec, sex, addWarn) {
        const list = [];
        const exact = new Set();
        const ext = new Map(); // base -> [{m, s}]
        for (let i = 1; i <= 20; i++) {
            const raw = trim(rec[`PROC${i}`]);
            if (!raw) continue;
            const [code, x] = raw.split('+');
            const row = this.proc.get(code);
            if (!row) { addWarn(8); continue; }
            if (exact.has(raw)) { addWarn(8); continue; }
            // a code refused for sex is not remembered: when it comes again it is refused for sex
            // again, not reported as a repeat (checked against the exe)
            if (row.sex !== 'B' && (!sex || row.sex !== (sex === '1' ? 'M' : 'F'))) { addWarn(16); continue; }
            exact.add(raw);
            if (!list.includes(code)) list.push(code);
            if (row.extType) {
                const m = x && /^(\d)(\d)$/.exec(x);
                if (!ext.has(code)) ext.set(code, []);
                ext.get(code).push(m ? { m: Number(m[1]), s: Number(m[2]) } : { m: 1, s: 1 });
            }
        }
        const derived = [];
        for (const [code, items] of ext) {
            const row = this.proc.get(code);
            const settings = [...new Set(items.map((e) => e.s))].sort((a, b) => a - b);
            const contiguous = settings.every((s, i) => s === i + 1) && items.every((e) => e.m >= 1 && e.s >= 1);
            if (!contiguous) continue;
            if (row.extType === '>') {
                // units: the largest number of sites given for each setting, summed over the settings
                let units = 0;
                for (const s of settings) units += Math.max(...items.filter((e) => e.s === s).map((e) => e.m));
                if (units > 1) derived.push(`${code}>1`);
            } else if (row.extType === '*') {
                if (settings.length > 1) derived.push(`${code}*1`);
            }
        }
        for (const [combo, [a, b]] of this.combos) {
            if (list.includes(a) && list.includes(b)) derived.push(combo);
        }
        return { list, all: [...list, ...derived] };
    }

    caseContext({ pdx, pdxMdc, sdx, procs, sex, age, los, admWt, dischOk, dischRaw }) {
        const self = this;
        const orProcs = procs.list.map((p) => this.proc.get(p)).filter((r) => r.group >= 1);
        const topGroup = orProcs.reduce((a, r) => Math.max(a, r.group), 0);
        const c = {
            pdx, pdxMdc, sdx: [...sdx], procs, sex, los, admWt,
            age: age,
            ageDays: age.totalDays,
            topGroup,
            orProcs,
            traumaSites: new Set(),
            multiTrauma: false,
            dischT() {
                if (!dischOk) throw new NeedError(8);
                return dischRaw;
            },
            row(code) {
                const row = self.dxRow(code, sex);
                if (self.dx.get(code).length > 1 && !sex) throw new NeedError(7);
                return row;
            },
            pdcOf(code, mdc) {
                const book = self.dxPdc[mdc]?.[code];
                if (book !== undefined) return book;
                const rows = self.dx.get(code) ?? [];
                const r = rows.find((x) => x.mdc === mdc && (rows.length === 1 || !sex || x.sex === (sex === '1' ? 'M' : 'F')));
                return r?.pdc ?? null;
            },
            dxIs(code, t, mdc) {
                if (t.kind === 'PDC') return c.pdcOf(code, mdc) === t.name;
                return self.ax.get(t.name)?.has(code) ?? false;
            },
            procIs(t, mdc) {
                if (t.kind === 'PDC') return procs.all.some((p) => self.procPdc[mdc]?.[p]?.includes(t.name));
                const set = self.ax.get(t.name);
                return set ? procs.all.some((p) => set.has(p)) : false;
            },
            dxMdcs(code) {
                const row = self.dxRow(code, sex);
                return row ? [row.mdc] : [];
            },
        };
        return c;
    }

    // ------------------------------------------------------------------ MDC and DC

    pdxMdc(c) {
        if (c.pdxMdc) return c.pdxMdc;
        return c.row(c.pdx).mdc;
    }

    findDc(c) {
        // Pre MDC
        for (const dc of this.flow['00']) {
            const d = this.dcs.get(dc);
            if (d && d.test(c, '00')) return d.dc;
        }
        // MDC 24: multiple significant trauma
        if (this.isMultiTrauma(c)) {
            c.multiTrauma = true;
            const dc = this.tryList(c, '24', this.flow['24']);
            if (dc) return dc;
        }
        let mdc = this.pdxMdc(c);
        if (c.ageDays < 28) mdc = '15';
        return this.runMdc(c, mdc, new Set());
    }

    isMultiTrauma(c) {
        const pdxRow = this.dxRow(c.pdx, c.sex);
        if (!pdxRow || pdxRow.trauma === 'N' || pdxRow.trauma === '') return false;
        const sites = new Set();
        for (const code of [c.pdx, ...c.sdx]) {
            const t = this.dxRow(code, c.sex)?.trauma;
            if (t && t !== 'N' && t !== '0') sites.add(t);
        }
        const procSites = new Set(c.orProcs.map((r) => r.site).filter((s) => s && s !== '-'));
        c.traumaSites = procSites;
        return sites.size >= 2 || procSites.size >= 2;
    }

    tryList(c, mdc, list) {
        for (const dc of list) {
            const d = this.dcs.get(dc);
            if (d && d.test(c, mdc)) return d.dc;
        }
        return null;
    }

    hasProcInMdc(c, mdc) {
        const table = this.procPdc[mdc];
        return !!table && c.procs.all.some((p) => table[p]);
    }

    runMdc(c, mdc, visited) {
        if (visited.has(mdc)) return null;
        visited.add(mdc);
        const order = this.flow[mdc];
        if (!order) return null;

        const branch = this.branch[mdc];
        if (branch && branch.test(c, mdc)) return this.tryList(c, mdc, branch.order);
        if (mdc === '14') return this.runMdc14(c, order, visited);
        if (mdc === '15' || mdc === '24') return this.tryList(c, mdc, order);

        const surgical = order.filter((dc) => parseInt(dc.slice(2, 4), 10) < 50);
        const medical = order.filter((dc) => parseInt(dc.slice(2, 4), 10) >= 50);

        // MDC 18, 23 and 25 reassign by procedure first, but (as UORP) not a minor OR procedure on
        // a long enough stay: that case goes on to the medical partitioning (checked against the exe).
        if (['18', '23', '25'].includes(mdc) && c.topGroup >= 1 && !this.minorLongStay(c)) {
            const moved = this.reassign(c, mdc, visited);
            if (moved !== undefined) return moved;
            const mos = this.mosDc(c);
            if (mos) return mos;
            return this.tryList(c, mdc, surgical) ?? this.tryList(c, mdc, medical);
        }

        const s = this.tryList(c, mdc, surgical);
        if (s) return s;
        if (UORP_MDCS.has(mdc) && c.topGroup >= 1 && !this.hasProcInMdc(c, mdc)) {
            const u = this.uorp(c, mdc, visited);
            if (u) return u;
        }
        return this.tryList(c, mdc, medical);
    }

    runMdc14(c, order, visited) {
        const pdc = c.pdcOf(c.pdx, '14') ?? '';
        for (const step of order) {
            if (step === 'UORP') {
                if (/^14[A-E]$/.test(pdc) && c.topGroup >= 1 && !this.hasProcInMdc(c, '14')) {
                    const u = this.uorp(c, '14', visited);
                    if (u) return u;
                }
                continue;
            }
            if (step === '14MX') {
                const ranges = this.obstetric[c.pdx];
                if (ranges) {
                    const hit = [...c.sdx].sort().reverse().find((s) => this.inRanges(s, ranges) && this.dxRow(s, c.sex)?.accPdx);
                    if (hit) {
                        const i = c.sdx.indexOf(hit);
                        c.sdx[i] = c.pdx;
                        c.pdx = hit;
                        c.pdxMdc = null;
                        return this.runMdc(c, this.pdxMdc(c), visited);
                    }
                }
                continue;
            }
            const d = this.dcs.get(step);
            if (d && d.test(c, '14')) return d.dc;
        }
        return null;
    }

    inRanges(code, ranges) {
        let ok = false;
        for (const r of ranges) {
            if (r.startsWith('!')) { if (code === r.slice(1)) return false; continue; }
            if (inRange(code, r)) ok = true;
        }
        return ok;
    }

    topProcs(c) {
        return c.orProcs.filter((r) => r.group === c.topGroup)
            .sort((a, b) => b.level - a.level || (a.code < b.code ? 1 : -1));
    }

    /** Appendix D steps 1-2: move the case to the MDC of the procedure. undefined when it does not apply. */
    reassign(c, mdc, visited) {
        const top = this.topProcs(c);
        const pdxRow = this.dxRow(c.pdx, c.sex);
        if (pdxRow?.mosDx) {
            const p = top.find((r) => r.mmdc && r.mmdc !== '--');
            if (p && p.mmdc !== mdc && !visited.has(p.mmdc)) return this.runMdc(c, p.mmdc, visited);
        }
        const cand = [];
        const sdxSorted = [...c.sdx].sort().reverse();
        for (const p of top) {
            const pm = [[p.mmdc, 1], ...p.omdcs.map((m) => [m, 0])].filter(([m]) => m && m !== '--' && m !== mdc && !visited.has(m));
            for (const [m, main] of pm) {
                for (const s of sdxSorted) {
                    // any SDx, asterisk codes too, with the MDC of the patient's sex
                    const rows = this.dx.get(s) ?? [];
                    if (!c.sex && new Set(rows.map((r) => r.mdc)).size > 1) throw new NeedError(7);
                    if (this.dxRow(s, c.sex)?.mdc === m) cand.push({ p, m, main, s, si: sdxSorted.indexOf(s) });
                }
            }
        }
        if (!cand.length) return undefined;
        cand.sort((a, b) => b.p.level - a.p.level || b.main - a.main || (a.p.code < b.p.code ? 1 : a.p.code > b.p.code ? -1 : 0) || a.si - b.si);
        const best = cand[0];
        const i = c.sdx.indexOf(best.s);
        c.sdx[i] = c.pdx;
        c.pdx = best.s;
        c.pdxMdc = best.m;
        return this.runMdc(c, best.m, visited);
    }

    /** OR procedure group 2 with LOS of 5 days or more, or group 1 with 4 days or more. */
    minorLongStay(c) {
        return (c.topGroup === 2 && c.los >= 5) || (c.topGroup === 1 && c.los >= 4);
    }

    mosDc(c) {
        const mos = this.topProcs(c).filter((r) => r.mosProc && r.mosDc).sort((a, b) => a.mosHier - b.mosHier);
        return mos.length ? mos[0].mosDc : null;
    }

    /** Appendix D: unrelated OR procedure. */
    uorp(c, mdc, visited) {
        // a minor OR procedure on a long enough stay stays in the MDC
        if (this.minorLongStay(c)) return null;
        const moved = this.reassign(c, mdc, visited);
        if (moved !== undefined) return moved;
        const mos = this.mosDc(c);
        if (mos) return mos;
        const g = c.topGroup;
        if (g >= 5) return '2605';
        if (g === 4) return '2604';
        if (g === 3) return '2603';
        if (g === 2 && c.los < 5) return '2602';
        if (g === 1 && c.los < 4) return '2601';
        return null;
    }

    // ------------------------------------------------------------------ result and AdjRW (Appendix H)

    adjRw(d, los, losMinutes) {
        if (los === null) return d.rw;
        if (los < d.wtlos / 3 || losMinutes < MINUTES_PER_DAY) {
            if (!d.rw0d) return d.rw;
            if (losMinutes < MINUTES_PER_DAY) return d.rw0d;
            if (d.wtlos > 3) return round4(d.rw0d + (los * (d.rw - d.rw0d)) / Math.ceil(d.wtlos / 3));
            return d.rw;
        }
        if (los > d.ot && d.ot > 0) {
            const medical = Number(d.drg.slice(2, 4)) >= 50;
            const [b12, b23] = medical ? (d.rw < 0.7 ? B.M1 : B.M2) : (d.rw < 2 ? B.P1 : B.P2);
            const of = d.of || 1;
            if (los <= 2 * d.ot) return round4(d.rw + of * b12 * (los - d.ot));
            if (los <= 3 * d.ot) return round4(d.rw + of * b12 * d.ot + of * b23 * (los - 2 * d.ot));
            return round4(d.rw + of * d.ot * (b12 + b23));
        }
        return d.rw;
    }

    result(r, c, los, losMinutes) {
        const drg = r.drg ?? (r.err ? DRG_ERROR[r.err] ?? DRG_ERROR_DEFAULT : DRG_ERROR_DEFAULT);
        const d = this.drg.get(drg);
        const out = {
            DRG: drg,
            MDC: d?.mdc ?? drg.slice(0, 2),
            ERR: r.err ?? 0,
            WARN: r.WARN,
            RW: d?.rw ?? 0,
            ADJRW: d ? this.adjRw(d, r.err ? null : los, losMinutes) : 0,
            WTLOS: d?.wtlos ?? 0,
            OT: d?.ot ?? 0,
            ACTLOS: los,
            DC: r.DC,
            PCL: r.PCL,
        };
        if (c) out.PDXUSED = c.pdx;
        return out;
    }
}
