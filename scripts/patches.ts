/**
 * Cut every intersection of every fixture into a labelled patch.
 *
 *   pnpm patches                 # all fixtures, into ./dataset/patches
 *   pnpm patches --out /tmp/set
 *
 * Writes `patches.bin` (one `PATCH` by `PATCH` byte per sample, back to back), `patches.tsv`
 * (a line per sample saying what is there and where it came from), `meta.json` and
 * `preview.png`.
 *
 * The corpus is already a labelled dataset and has been all along: the fixture SGF says what
 * stands on every point of every diagram, and the grid detector says where those points are
 * in the picture. Between them there is a training example for each of some twenty thousand
 * intersections, and another few hundred arrive with every snapshot added to the tests.
 *
 * Two labels come off each point, because they are two different questions:
 *
 *   `stone`    empty, b, w        — what is standing there
 *   `content`  none, digits, letter, mark — what, if anything, is printed on it
 *
 * The second is the one the hand-written rules answer worst. Deciding whether a point
 * carries a reference letter is currently a single threshold on how much grid line still
 * shows, and when it says yes wrongly the reader is handed a bare crossing and duly reads a
 * letter out of it. Both labels are free here, so both are recorded.
 *
 * **Labels come from the SGF, never from `classifyIntersection`.** Deriving them from the
 * rule being replaced would teach a model to imitate that rule, including where it is wrong.
 * What the rule says is recorded alongside, but only so this script can report how often the
 * two disagree — which is the baseline any learned reading has to beat, and which also
 * catches a fixture whose lattice is misplaced before its labels poison the set.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binarize } from '../src/detect/binarize.js';
import { deskewImage } from '../src/detect/deskew.js';
import { imageLevels, intersectionPatch, PATCH } from '../src/detect/patch.js';
import { classifyIntersection } from '../src/detect/stones.js';
import { findGrid } from '../src/imageToSgf.js';
import { parseSgf, pointKey, pointToSgf, printedStones, type SgfPosition } from '../src/sgf.js';
import type { RgbaImage } from '../src/types.js';
import { readFixture } from '../test/helpers/fixtures.js';
import { decodePng, writePng } from '../test/helpers/png.js';
import { makeDiagram } from './diagrams.js';
import { fixtureNames } from './fixtures.js';
import { splitOf, sourceOf } from './sources.js';
import { usableTypefaces } from './typefaces.js';

/**
 * Letters worth drawing, wider than any book prints.
 *
 * Same reasoning as `pnpm dataset`: a model that has only seen a to f has learned six shapes
 * rather than what a letter looks like. What is being learned here is narrower still — that
 * *something is printed* — and the surest way to teach it is to show it many things.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** How much of a fixture's points may disagree with the current rule before it looks broken. */
const SUSPECT_DISAGREEMENT = 0.05;

type Stone = 'empty' | 'b' | 'w';
type Content = 'none' | 'digits' | 'letter' | 'mark';

interface Sample {
  fixture: string;
  source: string;
  split: string;
  coord: string;
  stone: Stone;
  content: Content;
  /** The characters printed, or the mark's shape; empty where nothing is. */
  text: string;
  /** Which of the four lines run on past this point, as `lrud`. */
  edges: string;
  /** What the current hand-written rule says, so the two can be compared. */
  ruled: Stone;
  pixels: Uint8Array;
}

/** A patch as bytes: -1 becomes 0 and +1 becomes 255, so the file is a quarter the size. */
function quantise(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(((values[i] + 1) / 2) * 255)));
  }
  return bytes;
}

function cut(name: string, image: RgbaImage, expected: SgfPosition): Sample[] | null {
  const upright = deskewImage(image, binarize(image)).image;
  const mask = binarize(upright);
  const structure = binarize(upright, 'structure');

  let grid;
  try {
    // Through the reader's own door, and told the size by the fixture, exactly as the
    // evaluation does — so a patch sits where the reader would look for it.
    grid = findGrid(upright, expected.boardSize);
  } catch {
    return null;
  }

  const levels = imageLevels(upright, mask);
  // What the page draws, not what survives the sequence — see `printedStones`.
  const board = printedStones(expected);

  const printed = new Map<string, { content: Content; text: string }>();
  expected.moves.forEach((move, index) => {
    printed.set(pointToSgf(move.point), {
      content: 'digits',
      text: move.label ?? String(index + 1),
    });
  });
  for (const label of expected.labels) {
    printed.set(pointToSgf(label.point), { content: 'letter', text: label.text });
  }
  for (const mark of expected.marks) {
    printed.set(pointToSgf(mark.point), { content: 'mark', text: mark.shape });
  }

  const size = grid.boardSize;
  const { region } = grid;
  const scratch = new Float32Array(PATCH * PATCH);
  const samples: Sample[] = [];

  for (let row = 0; row < region.rows; row++) {
    for (let col = 0; col < region.cols; col++) {
      const point = { x: region.left + col, y: region.top + row };
      const coord = pointToSgf(point);
      const left = point.x > 0;
      const right = point.x < size - 1;
      const up = point.y > 0;
      const down = point.y < size - 1;

      intersectionPatch(upright, levels, grid.xs[col], grid.ys[row], grid.spacing, scratch);
      const { color } = classifyIntersection(
        mask,
        grid.xs[col],
        grid.ys[row],
        grid.spacing,
        { left, right, up, down },
        structure,
      );

      const here = printed.get(coord);
      samples.push({
        fixture: name,
        source: sourceOf(name),
        split: splitOf(name),
        coord,
        stone: (board.get(pointKey(point)) ?? 'empty') as Stone,
        content: here?.content ?? 'none',
        text: here?.text ?? '',
        edges: `${left ? 'l' : '-'}${right ? 'r' : '-'}${up ? 'u' : '-'}${down ? 'd' : '-'}`,
        ruled: (color ?? 'empty') as Stone,
        pixels: quantise(scratch),
      });
    }
  }

  return samples;
}

/** A contact sheet, so the set can be looked at rather than taken on trust. */
function preview(samples: Sample[], perRow: number): { image: RgbaImage; rows: string[] } {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.stone}/${s.content}`;
    const held = groups.get(key);
    if (held) held.push(s);
    else groups.set(key, [s]);
  }

  const rows = [...groups.keys()].sort();
  const cell = PATCH + 2;
  const width = perRow * cell;
  const height = rows.length * cell;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);

  rows.forEach((key, row) => {
    const pool = groups.get(key)!;
    // Spread across the group rather than taking the first few, which would all be one page.
    const stride = Math.max(1, Math.floor(pool.length / perRow));
    for (let column = 0; column < perRow; column++) {
      const s = pool[column * stride];
      if (!s) break;
      for (let y = 0; y < PATCH; y++) {
        for (let x = 0; x < PATCH; x++) {
          const at = ((row * cell + y + 1) * width + column * cell + x + 1) * 4;
          data[at] = data[at + 1] = data[at + 2] = s.pixels[y * PATCH + x];
          data[at + 3] = 255;
        }
      }
    }
  });

  return { image: { width, height, data }, rows };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const out = flag('out') ?? fileURLToPath(new URL('../dataset/patches', import.meta.url));
const count = Number(flag('count') ?? 400);
const seed = Number(flag('seed') ?? 1);

const samples: Sample[] = [];
const suspect: Array<[number, string, number]> = [];
let unreadable = 0;

for (const name of fixtureNames()) {
  const { png, expectedSgf } = readFixture(name);
  const cuts = cut(name, decodePng(png), parseSgf(expectedSgf));
  if (cuts === null) {
    unreadable++;
    console.log(`  no board found in ${name}`);
    continue;
  }

  const wrong = cuts.filter((s) => s.stone !== s.ruled).length;
  if (wrong / cuts.length > SUSPECT_DISAGREEMENT) suspect.push([wrong / cuts.length, name, wrong]);
  samples.push(...cuts);
}

// Drawn diagrams, for the one class the corpus cannot supply.
//
// Forty-four points in fifty-four books carry a reference letter, eight of them in the
// held-out sources. That is enough to measure against and nowhere near enough to learn from,
// and no amount of collecting fixes it quickly — books print few letters. The generator
// draws as many as are wanted, in every typeface installed, which is the same bargain
// `pnpm train` already strikes for the characters themselves: learn the shape from drawings,
// and keep the real pages for finding out whether it worked.
if (count > 0) {
  const faces = usableTypefaces();
  console.log(`drawing ${count} diagrams in ${faces.length} typefaces`);

  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const diagram = makeDiagram(seed * 1_000_003 + i, faces, {
      letters: LETTERS,
      shapes: ['triangle', 'square', 'circle', 'cross'],
      maxLetters: 20,
    });
    const cuts = cut(`drawn/${diagram.name}`, diagram.image, diagram.position);
    if (!cuts) continue;

    samples.push(...cuts);
    drawn++;
  }
  console.log(`${drawn} of ${count} drawn diagrams could be read well enough to cut up`);
}

mkdirSync(out, { recursive: true });

const pixels = new Uint8Array(samples.length * PATCH * PATCH);
samples.forEach((s, i) => pixels.set(s.pixels, i * PATCH * PATCH));
writeFileSync(join(out, 'patches.bin'), pixels);
writeFileSync(
  join(out, 'patches.tsv'),
  'fixture\tsource\tsplit\tcoord\tstone\tcontent\ttext\tedges\truled\n' +
    samples
      .map((s) =>
        [s.fixture, s.source, s.split, s.coord, s.stone, s.content, s.text, s.edges, s.ruled].join(
          '\t',
        ),
      )
      .join('\n') +
    '\n',
);

// The pixels and the labels go to separate files, so nothing would notice if the two drifted
// out of step — and a training set off by one row teaches the wrong thing without ever
// looking wrong.
const written = readFileSync(join(out, 'patches.bin'));
const lines = readFileSync(join(out, 'patches.tsv'), 'utf8').trim().split('\n').slice(1);
if (written.length !== samples.length * PATCH * PATCH || lines.length !== samples.length) {
  throw new Error(
    `wrote ${samples.length} samples but ${written.length} bytes and ${lines.length} labels`,
  );
}
for (const i of [0, samples.length >> 1, samples.length - 1]) {
  const start = i * PATCH * PATCH;
  const same = samples[i].pixels.every((value, p) => written[start + p] === value);
  if (!same || lines[i].split('\t')[3] !== samples[i].coord) {
    throw new Error(`sample ${i} does not match what was written`);
  }
}

const tally = <T extends string>(of: (s: Sample) => T, within = (_: Sample) => true) => {
  const counts = new Map<string, number>();
  for (const s of samples) if (within(s)) counts.set(of(s), (counts.get(of(s)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
};

const sources = new Map<string, Set<string>>();
for (const s of samples) {
  const held = sources.get(s.source);
  if (held) held.add(s.fixture);
  else sources.set(s.source, new Set([s.fixture]));
}

const trainable = samples.filter((s) => s.split === 'train');
const heldOut = samples.filter((s) => s.split === 'held-out');

writeFileSync(
  join(out, 'meta.json'),
  JSON.stringify(
    {
      size: PATCH,
      samples: samples.length,
      train: trainable.length,
      heldOut: heldOut.length,
      stone: Object.fromEntries(tally((s) => s.stone)),
      content: Object.fromEntries(tally((s) => s.content)),
      sources: Object.fromEntries(
        [...sources].sort().map(([name, fixtures]) => [name, fixtures.size]),
      ),
    },
    null,
    2,
  ) + '\n',
);

const sheet = preview(samples, 32);
writePng(join(out, 'preview.png'), sheet.image);

const rate = (within: Sample[]) => {
  const wrong = within.filter((s) => s.stone !== s.ruled).length;
  return within.length === 0 ? '-' : `${((100 * wrong) / within.length).toFixed(2)}% (${wrong})`;
};

console.log(`\n${samples.length} patches from ${fixtureNames().length - unreadable} fixtures -> ${out}`);
console.log(`  sources: ${sources.size}, of which held out: ${[...new Set(heldOut.map((s) => s.source))].join(', ')}`);
console.log(`  train ${trainable.length}   held out ${heldOut.length}`);
console.log(`  stone:   ${tally((s) => s.stone).map(([k, n]) => `${k} ${n}`).join('   ')}`);
console.log(`  content: ${tally((s) => s.content).map(([k, n]) => `${k} ${n}`).join('   ')}`);

console.log(`\nwhat the current rule gets wrong per intersection — the bar to beat:`);
console.log(`  train    ${rate(trainable)}`);
console.log(`  held out ${rate(heldOut)}`);

if (suspect.length > 0) {
  console.log(`\nfixtures where the rule and the SGF disagree a lot — check the lattice is placed right:`);
  for (const [share, name, wrong] of suspect.sort((a, b) => b[0] - a[0])) {
    console.log(`  ${(100 * share).toFixed(1).padStart(5)}%  ${wrong.toString().padStart(3)} points  ${name}`);
  }
}
console.log(`\npreview rows, top to bottom: ${sheet.rows.join(' ')}`);
