// Data-file layout required by the TCMC Thai DRG grouper (TGrp6305 manual, section 1.4).
// The same layout is accepted by the 5.1.1 and 6.2.x groupers the Hospital-OS module ships.

export const MAX_SDX = 12;
export const MAX_PROC = 20;

/** @type {import('./dbf.js').DbfField[]} */
export const DRG_FIELDS = [
    { name: 'DOB', type: 'D', length: 8 },
    { name: 'SEX', type: 'C', length: 1 },
    { name: 'DATEADM', type: 'D', length: 8 },
    { name: 'TIMEADM', type: 'C', length: 4 },
    { name: 'DATEDSC', type: 'D', length: 8 },
    { name: 'TIMEDSC', type: 'C', length: 4 },
    { name: 'DISCHT', type: 'C', length: 1 },
    { name: 'ADMWT', type: 'N', length: 7, decimals: 3 },
    { name: 'ACTLOS', type: 'N', length: 3 },
    { name: 'AGE', type: 'C', length: 3 },
    { name: 'AGEDAY', type: 'C', length: 3 },
    { name: 'PDX', type: 'C', length: 6 },
    ...Array.from({ length: MAX_SDX }, (_, i) => ({ name: `SDX${i + 1}`, type: 'C', length: 6 })),
    ...Array.from({ length: MAX_PROC }, (_, i) => ({ name: `PROC${i + 1}`, type: 'C', length: 7 })),
    { name: 'LEAVEDAY', type: 'N', length: 3 },
    { name: 'DRG', type: 'C', length: 5 },
    { name: 'MDC', type: 'C', length: 2 },
    { name: 'ERR', type: 'N', length: 2 },
    { name: 'WARN', type: 'N', length: 4 },
    { name: 'RW', type: 'N', length: 7, decimals: 4 },
    { name: 'OT', type: 'N', length: 4 },
    { name: 'WTLOS', type: 'N', length: 6, decimals: 2 },
    { name: 'ADJRW', type: 'N', length: 8, decimals: 4 },
];
