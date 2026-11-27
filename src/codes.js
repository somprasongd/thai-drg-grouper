// Error and warning codes from the TCMC grouper manual (TGrp6305, section 4).

export const ERROR_CODES = {
    1: 'No principal diagnosis',
    2: 'Invalid principal diagnosis',
    3: 'Unacceptable principal diagnosis',
    4: 'Principal diagnosis not valid for age',
    5: 'Principal diagnosis not valid for sex',
    6: 'Age error',
    7: 'Ungroupable due to sex error',
    8: 'Ungroupable due to discharge type error',
    9: 'Length of stay error',
    10: 'Ungroupable due to admission weight error',
};

// Warning is a bit mask: the grouper adds up every warning it finds.
export const WARNING_CODES = {
    1: 'SDx ใช้ไม่ได้ หรือซ้ำกับ PDx หรือซ้ำกันเอง',
    2: 'SDx ไม่เหมาะกับอายุ',
    4: 'SDx ไม่เหมาะกับเพศ หรือเป็นรหัสสำหรับเพศใดเพศหนึ่ง แต่ไม่มีข้อมูลเพศ',
    8: 'Proc ใช้ไม่ได้ หรือซ้ำกันเอง',
    16: 'Proc ไม่เหมาะกับเพศ หรือเป็นรหัสสำหรับเพศใดเพศหนึ่ง แต่ไม่มีข้อมูลเพศ',
    32: 'ไม่มีข้อมูลเพศ หรือใช้รหัสนอกเหนือจากที่กำหนด',
    64: 'ไม่มีประเภทการจำหน่ายออกจากโรงพยาบาล หรือใช้รหัสนอกเหนือจากที่กำหนด',
    128: 'ไม่มีวันที่ และ/หรือ เวลา ที่รับไว้ในรพ. หรือ มีแต่ไม่ถูกต้อง',
    256: 'ไม่มีวันที่ และ/หรือ เวลา ที่จำหน่ายออกจากรพ. หรือ มีแต่ไม่ถูกต้อง',
};

export const DISCHARGE_TYPES = {
    1: 'With approval',
    2: 'Against advice',
    3: 'Escape',
    4: 'Transfer',
    5: 'Other',
    8: 'Dead',
    9: 'Dead',
};

export function describeError(code) {
    if (!code) return null;
    return { code, message: ERROR_CODES[code] ?? 'Unknown error' };
}

export function describeWarnings(mask) {
    if (!mask) return [];
    const out = [];
    for (const bit of Object.keys(WARNING_CODES).map(Number)) {
        if (mask & bit) out.push({ code: bit, message: WARNING_CODES[bit] });
    }
    const known = Object.keys(WARNING_CODES).reduce((s, b) => s | Number(b), 0);
    if (mask & ~known) out.push({ code: mask & ~known, message: 'Unknown warning' });
    return out;
}
