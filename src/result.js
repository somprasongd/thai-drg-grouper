// One grouped case as the API answers it. Used by /group, /group/batch and the file formats.

import { describeError, describeWarnings } from './codes.js';

export function toResult(index, ref, version, pool, out, notes) {
    const drg = out.DRG || null;
    const err = out.ERR ?? 0;
    const warn = out.WARN ?? 0;
    const age = out.AGE === '' || out.AGE === undefined ? null : Number(out.AGE);
    const ageDay = out.AGEDAY === '' || out.AGEDAY === undefined ? null : Number(out.AGEDAY);
    return {
        index,
        ref: ref ?? null,
        ok: true,
        version,
        engine: pool.engine,
        drg,
        dc: out.DC ?? null,
        pcl: out.PCL ?? null,
        pdxUsed: out.PDXUSED ?? null,
        drgName: drg ? pool.drgTable.get(drg)?.name ?? null : null,
        mdc: out.MDC || null,
        rw: out.RW,
        adjrw: out.ADJRW,
        wtlos: out.WTLOS,
        ot: out.OT,
        los: out.ACTLOS,
        age: Number.isFinite(age) ? age : null,
        ageDay: Number.isFinite(ageDay) ? ageDay : null,
        errorCode: err,
        error: describeError(err),
        warningCode: warn,
        warnings: describeWarnings(warn),
        notes,
    };
}
