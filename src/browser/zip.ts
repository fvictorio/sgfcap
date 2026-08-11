/**
 * A minimal ZIP writer, so a fixture leaves the app as one file.
 *
 * Stored, never deflated. The only thing that goes in here is a PNG next to a few hundred
 * bytes of SGF, and a PNG is already deflated — compressing it again would buy nothing and
 * cost a compression library, which is a poor trade for a browser-only app that currently
 * ships none.
 */

/** One file in the archive. */
export interface Entry {
  name: string;
  /** Backed by a plain ArrayBuffer, which is what `Blob` will take. */
  bytes: Uint8Array<ArrayBuffer>;
}

const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };

/** Bundle entries into a zip, in the order given. */
export function zip(entries: readonly Entry[], now = new Date()): Blob {
  const time = dosTime(now);
  const names = entries.map((entry) => new TextEncoder().encode(entry.name));
  const crcs = entries.map((entry) => crc32(entry.bytes));

  const local: Array<Uint8Array<ArrayBuffer>> = [];
  const central: Array<Uint8Array<ArrayBuffer>> = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const name = names[i];

    const header = new Uint8Array(30 + name.length);
    const head = new DataView(header.buffer);
    head.setUint32(0, SIGNATURE.local, true);
    head.setUint16(4, 20, true); // version needed
    head.setUint16(6, 0, true); // flags
    head.setUint16(8, 0, true); // method: stored
    head.setUint16(10, time.time, true);
    head.setUint16(12, time.date, true);
    head.setUint32(14, crcs[i], true);
    head.setUint32(18, entry.bytes.length, true); // compressed size
    head.setUint32(22, entry.bytes.length, true); // uncompressed size
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true); // extra field length
    header.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const entryHead = new DataView(record.buffer);
    entryHead.setUint32(0, SIGNATURE.central, true);
    entryHead.setUint16(4, 20, true); // version made by
    entryHead.setUint16(6, 20, true); // version needed
    entryHead.setUint16(8, 0, true);
    entryHead.setUint16(10, 0, true);
    entryHead.setUint16(12, time.time, true);
    entryHead.setUint16(14, time.date, true);
    entryHead.setUint32(16, crcs[i], true);
    entryHead.setUint32(20, entry.bytes.length, true);
    entryHead.setUint32(24, entry.bytes.length, true);
    entryHead.setUint16(28, name.length, true);
    entryHead.setUint16(30, 0, true); // extra
    entryHead.setUint16(32, 0, true); // comment
    entryHead.setUint16(34, 0, true); // disk number
    entryHead.setUint16(36, 0, true); // internal attributes
    entryHead.setUint32(38, 0, true); // external attributes
    entryHead.setUint32(42, offset, true);
    record.set(name, 46);

    local.push(header, entry.bytes);
    central.push(record);
    offset += header.length + entry.bytes.length;
  });

  const directory = central.reduce((total, record) => total + record.length, 0);

  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, SIGNATURE.end, true);
  tail.setUint16(4, 0, true); // this disk
  tail.setUint16(6, 0, true); // disk the directory starts on
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, directory, true);
  tail.setUint32(16, offset, true);
  tail.setUint16(20, 0, true); // comment length

  return new Blob([...local, ...central, end], { type: 'application/zip' });
}

/** MS-DOS timestamp, which is what the format stores: two seconds' resolution and no timezone. */
function dosTime(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

let table: Uint32Array | null = null;

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
