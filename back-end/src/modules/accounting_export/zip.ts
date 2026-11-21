/**
 * Écriture ZIP minimale (deflate + CRC32), équivalent de
 * `zipfile.ZipFile(..., ZIP_DEFLATED)` utilisé par l'export comptable.
 * Pas de dépendance : un ZIP de deux petits CSV tient en ~100 lignes.
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface LocalEntry {
  name: Buffer;
  compressed: Buffer;
  method: number;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const d =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

/** Construit une archive ZIP (deflate) à partir de `name → bytes`. */
export function buildZip(files: Record<string, Buffer>, now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const entries: LocalEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuffer.copy(local, 30);

    entries.push({
      name: nameBuffer,
      compressed,
      method: 8,
      crc,
      size: content.length,
      offset,
      dosTime: time,
      dosDate: date,
    });
    chunks.push(local, compressed);
    offset += local.length + compressed.length;
  }

  const centralParts: Buffer[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(46 + entry.name.length);
    header.writeUInt32LE(0x02014b50, 0); // signature
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8); // UTF-8 flag
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.dosTime, 12);
    header.writeUInt16LE(entry.dosDate, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk start
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(entry.offset, 42);
    entry.name.copy(header, 46);
    centralParts.push(header);
    centralSize += header.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // central dir disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...centralParts, end]);
}
