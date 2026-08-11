import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { fixtureFromArchive } from './helpers/fixtures.js';
import { unzip } from './helpers/zip.js';
import { zip } from '../src/browser/zip.js';

/**
 * The archive a fixture can arrive in.
 *
 * The app writes these (`src/browser/zip.ts`) and the corpus reads them, so the two are
 * tested against each other rather than against a fixed blob: a round trip is the only thing
 * that can catch the writer and the reader drifting apart, which is the failure that would
 * quietly lose every fixture saved after it.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const SGF = '(;GM[1]FF[4]SZ[19]AB[dd])\n';

async function archive(files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }>) {
  return Buffer.from(await zip(files).arrayBuffer());
}

const png = (name: string) => ({ name, bytes: PNG });
const sgf = (name: string) => ({ name, bytes: new TextEncoder().encode(SGF) });

describe('a zipped fixture', () => {
  it('round-trips the pair the app saved', async () => {
    const fixture = fixtureFromArchive('demo', await archive([png('demo.png'), sgf('demo.sgf')]));

    expect(fixture.name).toBe('demo');
    expect(fixture.expectedSgf).toBe(SGF);
    expect(Uint8Array.from(fixture.png)).toEqual(PNG);
  });

  it('is named for the archive, not for what is inside it', async () => {
    const fixture = fixtureFromArchive('renamed', await archive([png('old.png'), sgf('old.sgf')]));

    expect(fixture.name).toBe('renamed');
  });

  it('reads deflated entries, in case it was repacked on the way', () => {
    // Built by hand rather than by `zip`, which only ever stores — the point is the other one.
    const body = deflateRawSync(Buffer.from(SGF));
    const [entry] = unzip(deflatedArchive('one.sgf', body, Buffer.byteLength(SGF)));

    expect(entry.bytes.toString('utf8')).toBe(SGF);
  });

  it('refuses an archive that is not exactly one fixture', async () => {
    const three = await archive([png('a.png'), sgf('a.sgf'), png('b.png')]);
    expect(() => fixtureFromArchive('a', three)).toThrow(/holds 3 files/);
  });

  it('refuses two files that are not a picture and its reading', async () => {
    const both = await archive([png('a.png'), png('b.png')]);
    expect(() => fixtureFromArchive('a', both)).toThrow(/one \.png and one \.sgf/);
  });

  it('refuses a pair that does not share a name', async () => {
    const odd = await archive([png('a.png'), sgf('b.sgf')]);
    expect(() => fixtureFromArchive('a', odd)).toThrow(/both must share one name/);
  });

  it('refuses something that is not a zip at all', () => {
    expect(() => fixtureFromArchive('a', Buffer.from('not a zip'))).toThrow(/Not a zip file/);
  });
});

/** A one-entry archive holding deflated data, which `zip` will not produce. */
function deflatedArchive(name: string, body: Buffer, size: number): Buffer {
  const label = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30 + label.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflated
  local.writeUInt32LE(0, 14); // crc, unchecked by the reader
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(label.length, 26);
  label.copy(local, 30);

  const central = Buffer.alloc(46 + label.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(label.length, 28);
  central.writeUInt32LE(0, 42);
  label.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + body.length, 16);

  return Buffer.concat([local, body, central, end]);
}
