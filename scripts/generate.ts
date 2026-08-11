/**
 * Make random fixtures, so the reader is exercised on more than the books to hand.
 *
 *   pnpm generate            # one fixture, random seed
 *   pnpm generate --seed 7   # the same fixture every time
 *   pnpm generate --count 20
 *
 * Writes a matched pair into test/data/generated, which the suite picks up like any other.
 * The diagrams themselves come from `diagrams.ts`, shared with `pnpm dataset`.
 *
 * The gap this fills is coverage, not realism. Real books are the only honest evidence that
 * a reading generalises, and a synthetic diagram is drawn by the same code that reads it, so
 * agreeing with itself proves less than a book does. What it can do is reach the parts no
 * fixture happens to cover: every crop, every size, and twenty-one typefaces rather than a
 * dozen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageToSgf } from '../src/imageToSgf.js';
import { finalStones, parseSgf, pointToSgf, serializeSgf, type SgfPosition } from '../src/sgf.js';
import type { RgbaImage } from '../src/types.js';
import { writePng } from '../test/helpers/png.js';
import { makeDiagram } from './diagrams.js';
import { usableTypefaces } from './typefaces.js';

const OUT = fileURLToPath(new URL('../test/data/generated', import.meta.url));

/**
 * Whether the reader gets this diagram exactly right.
 *
 * A kept fixture is a regression guard, not a bug report: it says *this must keep working*.
 * Anything the reader gets wrong the moment it is drawn is either a gap already known — a
 * face nothing has taught it, a letter drawn a way nothing covers — or a bug, and a bug wants
 * investigating and fixing, not committing as a permanently red test.
 *
 * So the rejects are the interesting output. Their count is how often a random diagram
 * inside the ranges here defeats the reader, and it is printed at the end of a run.
 */
async function reads(image: RgbaImage, position: SgfPosition): Promise<string | null> {
  let got;
  try {
    got = parseSgf(await imageToSgf(image));
  } catch (error) {
    return (error as Error).message.split(/[.:]/)[0];
  }

  const want = finalStones(position);
  const have = finalStones(got);
  for (const key of new Set([...want.keys(), ...have.keys()])) {
    if (want.get(key) !== have.get(key)) return 'stones misread';
  }

  const numbers = (p: SgfPosition) =>
    p.moves.map((move, i) => `${pointToSgf(move.point)}=${move.label ?? i + 1}`).join(' ');
  if (numbers(position) !== numbers(got)) return 'numbers misread';

  const marks = (p: SgfPosition) =>
    [...p.marks].map((m) => `${pointToSgf(m.point)}=${m.shape}`).sort().join(' ');
  if (marks(position) !== marks(got)) return 'marks misread';

  return null;
}


const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : Number(args[at + 1]);
};

const count = flag('count') ?? 1;
const base = flag('seed') ?? Math.floor(Math.random() * 1_000_000);

const faces = usableTypefaces({ readableOnly: !args.includes('--any-face') });
console.log(`${faces.length} typefaces available${faces.length === 0 ? ' — falling back to the built-in font' : ''}`);

const keepAll = args.includes('--keep-rejects');
const rejected: string[] = [];
let kept = 0;

for (let seed = base; kept < count && seed < base + count * 20; seed++) {
  // No letters on fixtures. The corpus has one f, three e and five c to recognise them by,
  // so a generated diagram full of them banks failures nobody has the evidence to fix. The
  // training set is where letters belong — see `pnpm dataset`.
  const made = makeDiagram(seed, faces, { letters: '' });
  const wrong = keepAll ? null : await reads(made.image, made.position);

  if (wrong !== null) {
    rejected.push(`${made.name}: ${wrong} — ${made.notes.join(', ')}`);
    continue;
  }

  mkdirSync(OUT, { recursive: true });
  writePng(join(OUT, `${made.name}.png`), made.image);
  writeFileSync(join(OUT, `${made.name}.sgf`), serializeSgf(made.position));
  kept++;
  console.log(`${made.name}: ${made.notes.join(', ')}`);
}

if (rejected.length > 0) {
  console.log(`\n${rejected.length} rejected, ${kept} kept — the reader got these wrong as drawn:`);
  for (const line of rejected) console.log(`  ${line}`);
}
