// Just enough of the zip format for .xlsx files: read the entries, change one, write the
// archive again. Entries that are not changed keep their compressed bytes as they were.
// No zip64, no encryption, no multi-disk archives (an .xlsx never needs them).

import { deflateRawSync, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/**
 * @returns {{ name: string, method: number, flags: number, time: number, date: number, crc: number,
 *   size: number, raw: Buffer, madeBy: number, needed: number, internal: number, external: number }[]}
 */
export function readZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new ZipError('not a zip file (no end of central directory)');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    let p = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || p === 0xffffffff || p + cdSize > eocd) throw new ZipError('zip64 or a broken zip file is not supported');
    const entries = [];
    for (let k = 0; k < count; k++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('broken zip central directory');
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const e = {
            madeBy: buf.readUInt16LE(p + 4),
            needed: buf.readUInt16LE(p + 6),
            flags: buf.readUInt16LE(p + 8),
            method: buf.readUInt16LE(p + 10),
            time: buf.readUInt16LE(p + 12),
            date: buf.readUInt16LE(p + 14),
            crc: buf.readUInt32LE(p + 16),
            compSize: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            internal: buf.readUInt16LE(p + 36),
            external: buf.readUInt32LE(p + 38),
            offset: buf.readUInt32LE(p + 42),
            name: buf.toString(buf.readUInt16LE(p + 8) & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
        };
        if (e.flags & 1) throw new ZipError('encrypted zip files are not supported (remove the password from the workbook)');
        const lp = e.offset;
        if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) throw new ZipError(`broken zip entry ${e.name}`);
        const dataAt = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
        if (dataAt + e.compSize > buf.length) throw new ZipError(`zip entry ${e.name} is cut short`);
        e.raw = buf.subarray(dataAt, dataAt + e.compSize);
        entries.push(e);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** The uncompressed bytes of an entry; `limit` guards against zip bombs. */
export function inflate(e, limit) {
    if (e.size > limit) throw new ZipError(`${e.name} is larger than ${limit} bytes`);
    if (e.method === 0) return e.raw;
    if (e.method !== 8) throw new ZipError(`${e.name} uses zip method ${e.method}; only stored and deflate are supported`);
    try {
        return inflateRawSync(e.raw, { maxOutputLength: limit });
    } catch (err) {
        throw new ZipError(`${e.name} cannot be unpacked: ${err.message}`);
    }
}

/** Give an entry new contents (deflated). */
export function replace(e, data) {
    e.raw = deflateRawSync(data);
    e.method = 8;
    e.crc = crc32(data);
    e.size = data.length;
    e.needed = Math.max(e.needed, 20);
}

export function writeZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, e.flags & 0x800 ? 'utf8' : 'latin1');
        const flags = e.flags & 0x806; // keep the deflate level bits and UTF-8 names; sizes are in the header now
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(e.needed, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(e.method, 8);
        local.writeUInt16LE(e.time, 10);
        local.writeUInt16LE(e.date, 12);
        local.writeUInt32LE(e.crc, 14);
        local.writeUInt32LE(e.raw.length, 18);
        local.writeUInt32LE(e.size, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, e.raw);

        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(e.madeBy, 4);
        c.writeUInt16LE(e.needed, 6);
        c.writeUInt16LE(flags, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(e.time, 12);
        c.writeUInt16LE(e.date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.raw.length, 20);
        c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(name.length, 28);
        c.writeUInt16LE(e.internal, 36);
        c.writeUInt32LE(e.external, 38);
        c.writeUInt32LE(offset, 42);
        central.push(c, name);
        offset += 30 + name.length + e.raw.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    if (offset > 0xffffffff) throw new ZipError('the workbook is too large');
    return Buffer.concat([...parts, cd, end]);
}
