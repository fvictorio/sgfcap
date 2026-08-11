import { inflateRawSync } from 'node:zlib';

/**
 * Reading a zip, for fixtures that arrive as one.
 *
 * The app saves a fixture as an archive of its image and its SGF, so that collecting one is
 * a keystroke rather than a filing exercise — see `src/browser/fixture.ts`. This is the other
 * end of that: enough of the format to get the two files back out.
 *
 * Node-side only, which is why it lives here rather than in `src/`. The writer had no
 * compression to do and so needed no library; the reader may be handed an archive that was
 * repacked by an ordinary zip tool along the way, so it takes deflate too — `node:zlib` is
 * built in and refusing would be an odd way to lose a fixture.
 */

const SIGNATURE = { central: 0x02014b50, end: 0x06054b50 };
const STORED = 0;
const DEFLATED = 8;

export interface Entry {
  name: string;
  bytes: Buffer;
}

/** Every file in the archive, in the order the central directory lists them. */
export function unzip(archive: Buffer, describe = 'archive'): Entry[] {
  const end = endOfCentralDirectory(archive, describe);
  const count = archive.readUInt16LE(end + 10);

  const entries: Entry[] = [];
  let at = archive.readUInt32LE(end + 16);

  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== SIGNATURE.central) {
      throw new Error(`Corrupt ${describe}: entry ${i + 1} is not where the directory says.`);
    }

    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);

    // The local header repeats the name and may carry a different amount of extra, so the
    // data's real offset can only be worked out from the local header itself.
    const localName = archive.readUInt16LE(offset + 26);
    const localExtra = archive.readUInt16LE(offset + 28);
    const from = offset + 30 + localName + localExtra;
    const raw = archive.subarray(from, from + compressed);

    if (method !== STORED && method !== DEFLATED) {
      throw new Error(`Unsupported compression (method ${method}) for "${name}" in ${describe}.`);
    }
    const bytes = method === STORED ? Buffer.from(raw) : inflateRawSync(raw);

    if (bytes.length !== size) {
      throw new Error(`Corrupt ${describe}: "${name}" unpacked to the wrong length.`);
    }

    entries.push({ name, bytes });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Find the end record, which is the only fixed point in the format.
 *
 * It sits last but its length is not fixed — an archive comment follows it — so it is found
 * by scanning back for its signature. The comment can be 64KB, and no further.
 */
function endOfCentralDirectory(archive: Buffer, describe: string): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let at = archive.length - 22; at >= earliest; at--) {
    if (archive.readUInt32LE(at) === SIGNATURE.end) return at;
  }

  throw new Error(`Not a zip file: ${describe}.`);
}
