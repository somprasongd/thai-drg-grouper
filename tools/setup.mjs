// npm run setup: get the TCMC files this grouper needs and build its rules.
//
//   node tools/setup.mjs [--cache=cache] [--offline] [--pdftotext=pdftotext] [--keep-text] [--strict]
//
//   --strict  stop when rules.json is not byte for byte the build that was compared with the exe
//
// 1. Downloads three zip files published by TCMC (www.tcmc.or.th) into the cache folder, or
//    uses the copies already there. Every zip is checked against its SHA-256 below.
//      S0021.zip  grouper TGrp6305 (Thai DRG 6.3.4)  -> only the tables c63*.dbf are taken
//      S0062.zip  Thai DRG 6.3.3 books 1 and 2       -> PDF
//      S0063.zip  Thai DRG 6.3.3 Appendix F          -> PDF
//    The exe and its DLLs in S0021.zip are never unpacked.
// 2. Copies the four tables to groupers/6.3.4/ (checked against their SHA-256).
// 3. Turns the PDF books into text with pdftotext (xpdf or poppler) and runs
//    tools/build-rules.mjs, which writes groupers/6.3.4/native/rules.json.
// 4. Groups one test case to show that it all works.
//
// None of these files are kept in git: they are TCMC's work (see NOTICE).

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const opt = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
}));
const CACHE = resolve(ROOT, opt.cache ?? 'cache');
const PDFTOTEXT = opt.pdftotext ?? process.env.PDFTOTEXT ?? 'pdftotext';
const VERSION = '6.3.4';
const OUT_DIR = join(ROOT, 'groupers', VERSION);
const BASE_URL = 'https://www.tcmc.or.th/_content_images/download/fileupload/';
// rules.json of the build that was compared with TGrp6305.exe (same with xpdf pdftotext 4.06 and poppler 26.01)
const RULES_SHA256 = '268fc6a36250de3a3256d215e60c5203013bb7c4a3eaa5eebd253f1364729c68';

const SOURCES = [
    {
        file: 'S0021.zip',
        size: 41903674,
        sha256: '014f33ec603b59d548c0d815efa3c49280ac7fcd09d0ee95d3a7e0cc45b02630',
        what: 'grouper TGrp6305 (Thai DRG 6.3.4), tables only',
        take: {
            'TGrp6305/c63i10.dbf': { to: 'c63i10.dbf', sha256: 'ff83d8e34305196b510d46aa4c715cd7e1967ea0bbd3eacd6306609e985e2ecf' },
            'TGrp6305/c63proc.dbf': { to: 'c63proc.dbf', sha256: '9c886c19780044959147e27473f9191093291ec13e38cbb605962c9d031a5ae9' },
            'TGrp6305/c63drg.dbf': { to: 'c63drg.dbf', sha256: '6d2017ba58929b9f1b20fb67da3ae6fa544967cce11349ef1681dc6f6dac7f0e' },
            'TGrp6305/c63ccex.dbf': { to: 'c63ccex.dbf', sha256: '66e7d44719a8d3bd3abfa09fd1f21d5ca99aebb17a7a024874412ca455b2f21d' },
        },
    },
    {
        file: 'S0062.zip',
        size: 8129230,
        sha256: '0ea85876046970be3ed20c83c336e96e0c98527b4f52f39be02e706b0fd9194a',
        what: 'Thai DRG 6.3.3 books 1 and 2',
        books: ['TDrg633Vol1OneFinC.pdf', 'TDrg633Vol2TwoFinC.pdf'],
    },
    {
        file: 'S0063.zip',
        size: 21498954,
        sha256: '69df7ee797662e0231e23b9d1c54ccefd51bab5c9f76c82c547419c263cbfa15',
        what: 'Thai DRG 6.3.3 Appendix F',
        books: ['TDrg633VSup11FinC.pdf', 'TDrg633VSup22FinC.pdf', 'TDrg633VSup33FinC.pdf', 'TDrg633VSup44FinC.pdf'],
    },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function fail(msg) {
    console.error(`\nsetup failed: ${msg}`);
    process.exit(1);
}

// ------------------------------------------------------------------ zip (stored + deflate only)
function readZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.toString('latin1', p + 46, p + 46 + nameLen);
        entries.set(name, { method, compSize, size, local });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return {
        names: [...entries.keys()],
        read(name) {
            const e = entries.get(name);
            if (!e) throw new Error(`${name} is not in the zip`);
            if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`bad zip entry ${name}`);
            const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
            const data = buf.subarray(start, start + e.compSize);
            if (e.method === 0) return Buffer.from(data);
            if (e.method === 8) return inflateRawSync(data);
            throw new Error(`${name}: zip method ${e.method} is not supported`);
        },
    };
}

// ------------------------------------------------------------------ download
async function getZip(src) {
    const path = join(CACHE, src.file);
    if (existsSync(path)) {
        const buf = readFileSync(path);
        if (sha256(buf) === src.sha256) {
            console.log(`  ${src.file}: using ${path}`);
            return buf;
        }
        console.log(`  ${src.file}: the copy in the cache has another checksum, downloading again`);
    }
    if (opt.offline) fail(`${src.file} is not in ${CACHE} and --offline was given`);
    const url = BASE_URL + src.file;
    console.log(`  ${src.file}: downloading ${url} (${mb(src.size)}, ${src.what})`);
    let buf;
    let why = '';
    // a broken transfer gives other bytes, so try a few times before giving up
    for (let attempt = 1; attempt <= 3; attempt++) {
        let res;
        try {
            res = await fetch(url, { headers: { 'user-agent': 'thai-drg-grouper-setup' } });
            if (!res.ok) {
                why = `HTTP ${res.status}`;
            } else {
                buf = Buffer.from(await res.arrayBuffer());
                if (sha256(buf) === src.sha256) break;
                why = `got ${buf.length} bytes (${res.headers.get('content-type')}) with checksum ${sha256(buf)}, expected ${src.size} bytes with ${src.sha256}`;
                buf = null;
            }
        } catch (e) {
            why = e.cause?.message ?? e.message;
        }
        console.log(`  ${src.file}: attempt ${attempt} failed: ${why}`);
    }
    if (!buf) {
        fail(`cannot get ${src.file} from ${url}: ${why}. If TCMC published a new file, this grouper is not checked with it. `
            + `Otherwise download it with a browser into ${CACHE} and run again.`);
    }
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(path, buf);
    return buf;
}

// ------------------------------------------------------------------ main
function checkPdftotext() {
    const r = spawnSync(PDFTOTEXT, ['-v'], { encoding: 'utf8' });
    if (r.error) {
        fail(`"${PDFTOTEXT}" was not found. Install poppler-utils (Linux: apt install poppler-utils, macOS: brew install poppler, Windows: xpdf or poppler) or pass --pdftotext=<path>.`);
    }
    return `${r.stdout}${r.stderr}`.split(/\r?\n/).find((l) => /version/i.test(l))?.trim() ?? PDFTOTEXT;
}

console.log(`Thai DRG ${VERSION} setup`);
const pdfTool = checkPdftotext();
console.log(`  pdftotext: ${pdfTool}`);

const work = mkdtempSync(join(tmpdir(), 'tdrg-setup-'));
const textDir = opt['keep-text'] ? join(CACHE, 'text') : join(work, 'text');
mkdirSync(textDir, { recursive: true });
mkdirSync(join(OUT_DIR, 'native'), { recursive: true });

try {
    for (const src of SOURCES) {
        const zip = readZip(await getZip(src));
        for (const [name, t] of Object.entries(src.take ?? {})) {
            const data = zip.read(name);
            if (sha256(data) !== t.sha256) fail(`${name} in ${src.file} has an unexpected checksum`);
            writeFileSync(join(OUT_DIR, t.to), data);
            console.log(`  -> groupers/${VERSION}/${t.to}`);
        }
        for (const book of src.books ?? []) {
            const pdf = join(work, book);
            writeFileSync(pdf, zip.read(book));
            execFileSync(PDFTOTEXT, ['-raw', '-enc', 'UTF-8', pdf, join(textDir, book.replace(/\.pdf$/i, '.txt'))], { stdio: 'inherit' });
            console.log(`  ${book} -> text`);
        }
    }

    const rulesFile = join(OUT_DIR, 'native', 'rules.json');
    console.log('building rules');
    execFileSync(process.execPath, [join(ROOT, 'tools', 'build-rules.mjs'), textDir, rulesFile], { stdio: 'inherit' });
    const rulesSha = sha256(readFileSync(rulesFile));
    console.log(`  -> groupers/${VERSION}/native/rules.json  sha256 ${rulesSha}`);
    if (rulesSha === RULES_SHA256) {
        console.log('  rules.json is the same as the build that was compared with TGrp6305.exe');
    } else {
        const msg = `rules.json is not the same as the build compared with TGrp6305.exe (expected ${RULES_SHA256}). Another pdftotext may break lines in another way; check with "npm run compare" before use.`;
        if (opt.strict) fail(msg);
        console.warn(`  WARNING: ${msg}`);
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}

// one case end to end
const { NativeGrouper } = await import('../src/native/engine.js');
const g = new NativeGrouper(OUT_DIR);
const r = g.group({
    SEX: '1', DOB: '1980-05-10', DATEADM: '2024-01-10', TIMEADM: '0830', DATEDSC: '2024-01-13', TIMEDSC: '1000',
    DISCHT: '1', PDX: 'K358', PROC1: '4709', LEAVEDAY: 0,
});
if (r.DRG !== '06070' || r.RW !== 1.2127) fail(`check case gave DRG ${r.DRG} RW ${r.RW}, expected 06070 1.2127`);
console.log('check case: appendectomy -> DRG 06070, RW 1.2127  OK');
console.log('done. Start the API with: npm start');
