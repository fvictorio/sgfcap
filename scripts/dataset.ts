/**
 * Build a labelled set of glyphs to train a classifier on.
 *
 *   pnpm dataset                    # books plus 400 generated diagrams
 *   pnpm dataset --count 2000       # more of them
 *   pnpm dataset --out /tmp/set
 *
 * Writes `glyphs.bin` (one 24x24 byte per pixel, samples back to back), `glyphs.tsv` (a
 * line per sample: what it is, where it came from, and the size it was printed at) and
 * `preview.png`, a contact sheet to look at before trusting any of it.
 *
 * Two things this is careful about.
 *
 * **Glyphs are cut out by the reader's own code**, not drawn in isolation. A classifier
 * trained on clean characters would meet none of what actually arrives: pieces of the
 * stone's outline fused to a digit, numbers clipped by a tight crop, strokes broken by a
 * photocopier. Training on what the segmenter really produces is the same discipline that
 * made the exemplar set work, for the same reason.
 *
 * **Negatives are collected too.** Roughly a quarter of the set is `nothing` — the crossing
 * of two grid lines, the corner of a board, a plain stone, a two-digit number fused into one
 * shape. That class is the point of the exercise as much as the characters are: half the
 * hand-written rules in `digits.ts` exist to answer "is there a character here at all", and
 * a classifier that has seen the alternatives answers it from evidence instead.
 *
 * Books and generated diagrams are both included and each sample records which it came
 * from, so the trainer can hold the books back: they are the only evidence about the next
 * book, and spending them on training buys a fraction of a percent and costs that.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pointGlyphs,
  splitGlyph,
  stoneGlyphAttempts,
  type Glyph,
} from '../src/detect/digits.js';
import { INPUT, toInput } from '../src/detect/net.js';
import { classifyIntersection } from '../src/detect/stones.js';
import { pointToSgf } from '../src/sgf.js';
import type { RgbaImage } from '../src/types.js';
import { writePng } from '../test/helpers/png.js';
import { makeDiagram } from './diagrams.js';
import { describeDiagram, fixtureNames, loadFixture, type Fixture, type Target } from './fixtures.js';
import { usableTypefaces } from './typefaces.js';

/** The square a glyph is scaled into — the net's input size. */
const SIZE = INPUT;

/** What a sample that is not a character is called. */
const NOTHING = 'nothing';

/**
 * Letters worth training on.
 *
 * Wider than the books print, deliberately. A classifier that has only seen a to f has
 * learned six shapes rather than what letters look like, and the generator can draw the
 * whole alphabet in fifty typefaces at no cost. The reader can still be told which subset
 * to expect at any given point.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** How many bare points and plain stones to keep per diagram, so negatives stay a minority. */
const NEGATIVES_PER_DIAGRAM = 3;

interface Sample {
  label: string;
  source: string;
  /** The size it was cut out at, before being scaled into the square. */
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * One sample, as the net will see it.
 *
 * The scaling itself lives in `net.ts` and is shared with the runtime, so training data and
 * what the reader feeds the model can never drift apart.
 */
function sample(glyph: Glyph): Uint8Array {
  const scratch = new Float32Array(SIZE * SIZE);
  toInput(glyph, scratch);

  const pixels = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < pixels.length; i++) pixels[i] = scratch[i] > 0 ? 255 : 0;
  return pixels;
}

/** The pieces a labelled target comes apart into, one per character, or null. */
function segment(fixture: Fixture, target: Target): Glyph[] | null {
  const { mask, grid } = fixture;
  const want = target.kind === 'mark' ? 1 : target.text.length;

  if (target.color === null) {
    const glyphs = pointGlyphs(mask, target.x, target.y, grid.spacing);
    return glyphs.length === want ? glyphs : null;
  }

  const attempts = [...stoneGlyphAttempts(mask, target.x, target.y, grid.spacing, target.color)];
  for (const attempt of attempts) {
    if (attempt.length === want) return attempt;
  }

  // A number set tight arrives as fewer pieces than it has digits; the fixture says how many
  // there should be, so keep splitting the widest until the count is right.
  for (const attempt of attempts) {
    const pieces = cutToCount(attempt, want);
    if (pieces) return pieces;
  }

  return null;
}

function cutToCount(glyphs: Glyph[], want: number): Glyph[] | null {
  if (glyphs.length === 0 || glyphs.length > want) return null;

  let pieces = [...glyphs];
  while (pieces.length < want) {
    let widest = 0;
    for (let i = 1; i < pieces.length; i++) {
      if (pieces[i].width / pieces[i].height > pieces[widest].width / pieces[widest].height) {
        widest = i;
      }
    }

    const split = splitGlyph(pieces[widest]);
    if (!split) return null;
    pieces = [...pieces.slice(0, widest), ...split, ...pieces.slice(widest + 1)];
  }

  return pieces.some((piece) => piece.width / piece.height < 0.12) ? null : pieces;
}

/** Everything a single diagram has to teach, characters and negatives alike. */
function collect(fixture: Fixture, chance: () => number): Sample[] {
  const samples: Sample[] = [];
  const add = (label: string, glyph: Glyph) =>
    samples.push({
      label,
      source: fixture.name,
      width: glyph.width,
      height: glyph.height,
      pixels: sample(glyph),
    });

  const labelled = new Set(fixture.targets.map((target) => target.coord));

  for (const target of fixture.targets) {
    const pieces = segment(fixture, target);
    if (pieces === null) continue;

    if (target.kind === 'mark') {
      add(target.text, pieces[0]);
      continue;
    }
    pieces.forEach((glyph, i) => add(target.text[i], glyph));

    // A two-digit number that arrives fused is one shape that is not one character — the
    // hardest negative there is, and the one that has cost the most: a fused pair reads as
    // a plausible wrong number more readily than as nothing.
    if (target.color !== null && target.text.length > 1) {
      for (const attempt of stoneGlyphAttempts(
        fixture.mask,
        target.x,
        target.y,
        fixture.grid.spacing,
        target.color,
      )) {
        if (attempt.length === 1) {
          add(NOTHING, attempt[0]);
          break;
        }
      }
    }
  }

  // Bare points and plain stones: line crossings, board corners, star points, blank stones.
  // Sampled rather than taken wholesale — a full board offers three hundred of them and the
  // characters would drown.
  const { region, xs, ys, spacing } = fixture.grid;
  const empty: Glyph[] = [];
  const plain: Glyph[] = [];

  for (let row = 0; row < region.rows; row++) {
    for (let col = 0; col < region.cols; col++) {
      const point = { x: region.left + col, y: region.top + row };
      if (labelled.has(pointToSgf(point))) continue;

      const { color } = classifyIntersection(fixture.mask, xs[col], ys[row], spacing, {
        left: point.x > 0,
        right: point.x < 18,
        up: point.y > 0,
        down: point.y < 18,
      });

      if (color === null) empty.push(...pointGlyphs(fixture.mask, xs[col], ys[row], spacing));
      else {
        for (const attempt of stoneGlyphAttempts(fixture.mask, xs[col], ys[row], spacing, color)) {
          if (attempt.length > 0) {
            plain.push(...attempt);
            break;
          }
        }
      }
    }
  }

  for (const pool of [empty, plain]) {
    for (const glyph of pick(pool, NEGATIVES_PER_DIAGRAM, chance)) add(NOTHING, glyph);
  }

  return samples;
}

function pick<T>(items: T[], count: number, chance: () => number): T[] {
  if (items.length <= count) return items;

  const taken = [...items];
  for (let i = taken.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [taken[i], taken[j]] = [taken[j], taken[i]];
  }
  return taken.slice(0, count);
}

/** A contact sheet, so the set can be looked at rather than taken on trust. */
function preview(samples: Sample[], chance: () => number): { image: RgbaImage; order: string[] } {
  const byLabel = new Map<string, Sample[]>();
  for (const s of samples) (byLabel.get(s.label) ?? byLabel.set(s.label, []).get(s.label)!).push(s);

  const order = [...byLabel.keys()].sort();
  const perRow = 24;
  const cell = SIZE + 2;
  const width = perRow * cell;
  const height = order.length * cell;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);

  order.forEach((label, row) => {
    pick(byLabel.get(label)!, perRow, chance).forEach((s, column) => {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const value = 255 - s.pixels[y * SIZE + x];
          const at = ((row * cell + y + 1) * width + column * cell + x + 1) * 4;
          data[at] = data[at + 1] = data[at + 2] = value;
          data[at + 3] = 255;
        }
      }
    });
  });

  return { image: { width, height, data }, order };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const count = Number(flag('count') ?? 400);
const seed = Number(flag('seed') ?? 1);
const out = flag('out') ?? fileURLToPath(new URL('../dataset', import.meta.url));

let state = seed >>> 0;
const chance = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const samples: Sample[] = [];

for (const name of fixtureNames()) {
  const fixture = loadFixture(name);
  if (fixture) samples.push(...collect(fixture, chance));
}
const fromBooks = samples.filter((s) => !s.source.startsWith('generated/')).length;
console.log(`${fromBooks} samples from the books`);

// Every face, including the italics the reader currently fails on: the whole point of
// training is to cover what no book in the corpus happens to print.
const faces = usableTypefaces();
console.log(`drawing ${count} diagrams in ${faces.length} typefaces`);

let drawn = 0;
for (let i = 0; i < count; i++) {
  const diagram = makeDiagram(seed * 1_000_003 + i, faces, { letters: LETTERS, shapes: ['triangle', 'square', 'circle', 'cross'], maxLetters: 20 });
  const described = describeDiagram(`drawn/${diagram.name}`, diagram.image, diagram.position);
  if (!described) continue;

  samples.push(...collect(described, chance));
  drawn++;
}
console.log(`${drawn} of ${count} drawn diagrams could be read well enough to cut up`);

mkdirSync(out, { recursive: true });

const pixels = new Uint8Array(samples.length * SIZE * SIZE);
samples.forEach((s, i) => pixels.set(s.pixels, i * SIZE * SIZE));
writeFileSync(join(out, 'glyphs.bin'), pixels);
writeFileSync(
  join(out, 'glyphs.tsv'),
  `label\tsource\twidth\theight\n` +
    samples.map((s) => `${s.label}\t${s.source}\t${s.width}\t${s.height}`).join('\n') +
    '\n',
);

const counts = new Map<string, number>();
for (const s of samples) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
const classes = [...counts.keys()].sort();

writeFileSync(
  join(out, 'meta.json'),
  JSON.stringify(
    {
      size: SIZE,
      samples: samples.length,
      classes,
      counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
      books: fromBooks,
      drawn: samples.length - fromBooks,
    },
    null,
    2,
  ) + '\n',
);

// Read it back and check it lines up. The pixels and the labels are written to separate
// files, so nothing else would notice if the two ever drifted out of step — and a training
// set silently off by one row teaches the wrong thing without ever looking wrong.
const written = readFileSync(join(out, 'glyphs.bin'));
const lines = readFileSync(join(out, 'glyphs.tsv'), 'utf8').trim().split('\n').slice(1);
if (written.length !== samples.length * SIZE * SIZE || lines.length !== samples.length) {
  throw new Error(`wrote ${samples.length} samples but ${written.length} bytes and ${lines.length} labels`);
}
for (const i of [0, samples.length >> 1, samples.length - 1]) {
  const at = i * SIZE * SIZE;
  const same = samples[i].pixels.every((value, p) => written[at + p] === value);
  if (!same || lines[i].split('\t')[0] !== samples[i].label) {
    throw new Error(`sample ${i} does not match what was written`);
  }
}

const sheet = preview(samples, chance);
writePng(join(out, 'preview.png'), sheet.image);

console.log(`\n${samples.length} samples over ${classes.length} classes -> ${out}`);
console.log(
  '  ' +
    [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, n]) => `${label}:${n}`)
      .join(' '),
);
console.log(`  preview rows, top to bottom: ${sheet.order.join(' ')}`);
