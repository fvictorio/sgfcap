import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from './zip.js';

export interface Fixture {
  /** Base name, e.g. "foo" for foo.png / foo.sgf, or for foo.zip. */
  name: string;
  /** The PNG itself rather than a path to it, since a zipped fixture has no path of its own. */
  png: Buffer;
  expectedSgf: string;
}

export const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

/**
 * Every fixture under test/data: a `<name>.png` beside its `<name>.sgf`, or a `<name>.zip`
 * holding both.
 *
 * Adding a case is still just dropping files in — no test code changes. The zip is what the
 * app itself saves (see `src/browser/fixture.ts`), so a diagram read in the browser, corrected
 * on the board and saved becomes a test by being moved into this directory, which is the
 * whole reason the format is understood here.
 *
 * Subdirectories are walked too, which is what keeps the machine-generated ones in
 * `generated/` from burying the book scans they are there to supplement: the name carries the
 * folder, so `generated/gen-000042` reads as what it is wherever it turns up.
 */
export function discoverFixtures(): Fixture[] {
  const fixtures = fixturePaths(DATA_DIR)
    .sort()
    .map((relative) => readFixture(relative.slice(0, -extname(relative).length), relative));

  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.name)) {
      throw new Error(`Fixture "${fixture.name}" is present twice — as a zip and as loose files.`);
    }
    seen.add(fixture.name);
  }

  return fixtures;
}

/**
 * One fixture by name, however it is stored.
 *
 * `relative` is the file it was found as, which is only known to the walk. Given just a name,
 * the zip is tried first and loose files second — the same order `fixturePaths` reports them
 * in, so the two agree about which file a name refers to.
 */
export function readFixture(name: string, relative = ''): Fixture {
  const archive = relative.toLowerCase().endsWith('.zip')
    ? join(DATA_DIR, relative)
    : join(DATA_DIR, `${name}.zip`);

  if (existsSync(archive)) return fixtureFromArchive(name, readFileSync(archive));

  const sgfPath = join(DATA_DIR, `${name}.sgf`);
  const pngPath = join(DATA_DIR, `${name}.png`);
  if (!existsSync(sgfPath)) {
    throw new Error(`Fixture "${name}" has no expected result — create ${sgfPath}.`);
  }

  return { name, png: readFileSync(pngPath), expectedSgf: readFileSync(sgfPath, 'utf8') };
}

/**
 * Unpack a zipped fixture, insisting it is exactly one.
 *
 * A fixture is a picture and what that picture says, and an archive holding anything else is
 * not one — most likely a whole folder of them zipped together, or a save that went wrong.
 * Better to say so by name than to guess which two files were meant and quietly measure
 * against the wrong SGF.
 */
export function fixtureFromArchive(name: string, archive: Buffer): Fixture {
  const label = `${name}.zip`;
  const entries = unzip(archive, label);

  if (entries.length !== 2) {
    throw new Error(`${label} holds ${entries.length} files; a fixture is exactly a PNG and an SGF.`);
  }

  const png = entries.find((entry) => entry.name.toLowerCase().endsWith('.png'));
  const sgf = entries.find((entry) => entry.name.toLowerCase().endsWith('.sgf'));
  if (!png || !sgf) {
    const held = entries.map((entry) => entry.name).join(', ');
    throw new Error(`${label} must hold one .png and one .sgf; it holds ${held}.`);
  }

  const inside = (entry: { name: string }) => entry.name.slice(0, -extname(entry.name).length);
  if (inside(png) !== inside(sgf)) {
    throw new Error(`${label} pairs ${png.name} with ${sgf.name}; both must share one name.`);
  }

  // Named for the file on disk, not for what is inside it. That is the name the directory
  // listing shows and the one a failure will be reported under, so renaming the archive
  // renames the fixture and there is only ever one answer to what a fixture is called.
  return { name, png: png.bytes, expectedSgf: sgf.bytes.toString('utf8') };
}

/** Every fixture under `directory` — zips and loose PNGs alike — as paths relative to it. */
export function fixturePaths(directory: string, prefix = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...fixturePaths(join(directory, entry.name), relative));
      continue;
    }

    const kind = extname(entry.name).toLowerCase();
    if (kind === '.png' || kind === '.zip') found.push(relative);
  }

  return found;
}
