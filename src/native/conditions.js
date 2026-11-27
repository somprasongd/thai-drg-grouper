// Compiles the DC definitions of the TCMC books ("PDx as PDC 5A and Proc as AX 5PHX", ...)
// into functions of a case.  Each line of a DC definition is one alternative; inside a line
// "or" binds tighter than "and" / "w" (with) / "wo" (without), as the books use them.

export class NeedError extends Error {
    /** @param {number} err grouper error number (7 sex, 8 discharge type, 10 admission weight) */
    constructor(err) {
        super(`grouper error ${err}`);
        this.err = err;
    }
}

const CONNECTORS = new Set(['and', 'w', 'wo', 'or']);

function normalise(line) {
    return line
        .replace(/\bDischt\b/g, 'DischT')
        .replace(/AX 14 HX/g, 'AX 14HX')
        .replace(/Age>27 d(?:ays)? wo AdmWt/g, 'AGE27_NO_WT')
        .replace(/OR [Pp]roc(?:edure)? group (\d(?: or \d)*)/g, (_, g) => `ORGROUP_${g.replace(/ or /g, '_')}`)
        .replace(/Proc for trauma site ([A-J]) and ([A-J])\b/g, 'TSITE_$1 and TSITE_$2')
        .replace(/Proc for trauma site ([A-J])\b/g, 'TSITE_$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Split at connectors that are outside parentheses. */
function tokens(line) {
    const out = [];
    let depth = 0;
    let cur = [];
    for (const word of line.split(' ')) {
        if (depth === 0 && CONNECTORS.has(word)) {
            if (cur.length) out.push({ atom: cur.join(' ') });
            out.push({ conn: word });
            cur = [];
        } else {
            cur.push(word);
        }
        for (const ch of word) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
        }
    }
    if (cur.length) out.push({ atom: cur.join(' ') });
    return out;
}

/** "PDC 5A" | "AX 5BX" | "PDC (14H or 14K)" | "(PDC 17A or PDC 17B)" | "(AX a or AX b)" -> [{kind, name}] */
function targets(text) {
    let t = text.trim();
    let m;
    if ((m = /^(PDC|AX) \((.+)\)$/.exec(t))) return m[2].split(/ or /).map((n) => ({ kind: m[1], name: n.trim() }));
    if (/^\(.+\)$/.test(t)) t = t.slice(1, -1);
    return t.split(/ or /).map((p) => {
        const mm = /^(PDC|AX) (\S+)$/.exec(p.trim());
        if (!mm) throw new Error(`cannot read target "${text}"`);
        return { kind: mm[1], name: mm[2] };
    });
}

function cmp(op, a, b) {
    return op === '>' ? a > b : a < b;
}

/** Compile one atom into (c, mdc) => boolean, where c is the case context of engine.js. */
function atom(text) {
    let m;
    if ((m = /^(PDx|SDx|Dx|\(PDx or SDx\)|Proc) as (.+)$/.exec(text))) {
        const who = m[1];
        const list = targets(m[2]);
        if (who === 'Proc') return (c, mdc) => list.some((t) => c.procIs(t, mdc));
        const pdx = who === 'PDx' || who !== 'SDx';
        const sdx = who !== 'PDx';
        return (c, mdc) => list.some((t) => (pdx && c.dxIs(c.pdx, t, mdc)) || (sdx && c.sdx.some((s) => c.dxIs(s, t, mdc))));
    }
    if ((m = /^\(PDx or SDx\) not in (.+)$/.exec(text))) {
        const list = targets(m[1]);
        return (c, mdc) => ![c.pdx, ...c.sdx].some((d) => list.some((t) => c.dxIs(d, t, mdc)));
    }
    if ((m = /^No Dx in (.+)$/.exec(text))) {
        const list = targets(m[1]);
        return (c, mdc) => ![c.pdx, ...c.sdx].some((d) => list.some((t) => c.dxIs(d, t, mdc)));
    }
    if (text === 'SDx in this MDC') return (c, mdc) => c.sdx.some((s) => c.dxMdcs(s).includes(mdc));
    if ((m = /^Age ?([<>]) ?(\d+)$/.exec(text))) {
        const [op, n] = [m[1], Number(m[2])];
        return (c) => cmp(op, c.age.years, n);
    }
    if ((m = /^Age ?([<>]) ?(\d+) d(?:ays)?$/.exec(text))) {
        const [op, n] = [m[1], Number(m[2])];
        return (c) => cmp(op, c.ageDays, n);
    }
    if (text === 'AGE27_NO_WT') return (c) => c.ageDays > 27 && c.admWt === null;
    if ((m = /^LOS ?([<>]) ?(\d+) ?d(?:ays)?$/.exec(text))) {
        const [op, n] = [m[1], Number(m[2])];
        return (c) => cmp(op, c.los, n);
    }
    if ((m = /^DischT (not )?(\d)$/.exec(text))) {
        const [not, v] = [!!m[1], m[2]];
        return (c) => (c.dischT() === v) !== not;
    }
    if ((m = /^DischT (?:= )?\((.+)\)$/.exec(text))) {
        const vals = m[1].split(/,? or |, /).map((s) => s.trim());
        return (c) => vals.includes(c.dischT());
    }
    if ((m = /^AdmWt ?([<>]) ?([\d.]+) kg$/.exec(text))) {
        const [op, n] = [m[1], Number(m[2])];
        return (c) => c.admWt !== null && cmp(op, c.admWt, n);
    }
    if ((m = /^AdmWt ([\d.]+) ?- ?([\d.]+) kg$/.exec(text))) {
        const [lo, hi] = [Number(m[1]), Number(m[2])];
        return (c) => c.admWt !== null && c.admWt >= lo && c.admWt <= hi;
    }
    if ((m = /^ORGROUP_([\d_]+)$/.exec(text))) {
        const groups = m[1].split('_').map(Number);
        return (c) => groups.includes(c.topGroup);
    }
    if ((m = /^TSITE_([A-J])$/.exec(text))) {
        const site = m[1];
        return (c) => c.traumaSites.has(site);
    }
    if (text === 'CaRT') return (c, mdc) => c.sdx.some((s) => c.dxIs(s, { kind: 'AX', name: '99BX' }, mdc)) && c.procIs({ kind: 'AX', name: '99PEX' }, mdc);
    if (text === 'CaCRx') return (c, mdc) => c.sdx.some((s) => c.dxIs(s, { kind: 'AX', name: '99CX' }, mdc)) && c.procIs({ kind: 'AX', name: '99PFX' }, mdc);
    if (text === 'Any diagnosis of multiple significant trauma') return (c) => c.multiTrauma;
    throw new Error(`unknown condition "${text}"`);
}

/** Compile one definition line. */
export function compileLine(line) {
    const toks = tokens(normalise(line));
    // terms joined by and/w/wo; each term is an OR of atoms
    const terms = [];
    let neg = false;
    let joinOr = false;
    for (const t of toks) {
        if (t.conn) {
            if (t.conn === 'or') joinOr = true;
            else {
                neg = t.conn === 'wo';
                joinOr = false;
            }
            continue;
        }
        const fn = atom(t.atom);
        if (joinOr && terms.length) terms[terms.length - 1].any.push(fn);
        else terms.push({ neg, any: [fn] });
        neg = false;
        joinOr = false;
    }
    return (c, mdc) => terms.every((t) => t.any.some((f) => f(c, mdc)) !== t.neg);
}

/** Compile the alternatives of a DC: true when any line holds. */
export function compileDc(lines) {
    const alts = lines.map(compileLine);
    return (c, mdc) => alts.some((f) => f(c, mdc));
}
