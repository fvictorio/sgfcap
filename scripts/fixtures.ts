/**
 * Walking the fixtures as labelled data.
 *
 * Every fixture states what each stone is numbered and what each marked point says, so the
 * test corpus doubles as a labelled set for glyph recognition. `pnpm dataset` reads it
 * through here, so what is learned and what is measured agree on the ground truth.
 */
import { extname } from 'node:path';
import { binarize, localizeStones, type BinaryImage } from '../src/detect/binarize.js';
import { deskewImage } from '../src/detect/deskew.js';
import type { Grid } from '../src/detect/grid.js';
import { findGrid } from '../src/imageToSgf.js';
import { classifyIntersection } from '../src/detect/stones.js';
import { parseSgf, pointKey, pointToSgf, printedStones, type SgfPosition } from '../src/sgf.js';
import type { RgbaImage, StoneColor } from '../src/types.js';
import { DATA_DIR, fixturePaths, readFixture } from '../test/helpers/fixtures.js';
import { decodePng } from '../test/helpers/png.js';

/** Where the corpus lives, under the name the scripts have always called it. */
export const DATA = DATA_DIR;

/** One place in a diagram that carries something printed, and what the fixture says it is. */
export interface Target {
  coord: string;
  /** The characters of a label, or the name of a mark's shape. */
  text: string;
  kind: 'label' | 'mark';
  /**
   * What the diagram says this is, as opposed to what the image looks like.
   *
   * A move's caption is a number and a point's is a letter, and the fixture settles which
   * without anyone having to look at the pixels. Deciding it from `color` instead — a
   * number is on a stone, a letter is not — sounds equivalent and is not: where a numbered
   * stone reads as an empty point, its digits get filed under the letters, and the letter
   * alphabet fills up with 2s and 5s that then win matches they should never have entered.
   */
  writes: 'digits' | 'letter' | 'shape';
  /** null where the text sits on a bare point rather than a stone. */
  color: StoneColor | null;
  x: number;
  y: number;
}

export interface Fixture {
  name: string;
  mask: BinaryImage;
  grid: Grid;
  targets: Target[];
}

export function fixtureNames(): string[] {
  return fixturePaths(DATA)
    .map((file) => file.slice(0, -extname(file).length))
    .sort();
}

/**
 * Read a fixture and locate everything in it that is labelled.
 *
 * Returns null when the board cannot be found at all — there is nothing to learn from or
 * measure against in that case, and it is the grid's failure rather than the reader's.
 */
export function loadFixture(name: string): Fixture | null {
  const { png, expectedSgf } = readFixture(name);
  return describeDiagram(name, decodePng(png), parseSgf(expectedSgf));
}

/**
 * Read a diagram and locate everything in it that is labelled, given the picture and what
 * it is supposed to say.
 *
 * Split out from `loadFixture` so that a diagram held only in memory — one the generator
 * has just drawn — can be walked the same way a fixture on disk is.
 */
export function describeDiagram(
  name: string,
  image: RgbaImage,
  expected: SgfPosition,
): Fixture | null {
  const upright = deskewImage(image, binarize(image));
  const plain = binarize(upright.image);

  let grid: Grid;
  try {
    // Through the same door the reader uses, so what is learned and what is measured agree
    // with what is read. The fixture's own SGF says how big the board is.
    grid = findGrid(upright.image, expected.boardSize);
  } catch {
    return null;
  }

  // The same mask the reader cuts glyphs from, black stones re-thresholded against
  // themselves — see `localizeStones`. It has to be the same or what is learned here is not
  // what is read there: a white number on a black stone comes away with a different shape
  // under a page-wide cutoff than under the stone's own, and a model taught on one and shown
  // the other is being asked a question it was never trained for.
  const blacks: Array<{ cx: number; cy: number }> = [];
  for (let row = 0; row < grid.region.rows; row++) {
    for (let col = 0; col < grid.region.cols; col++) {
      const { color } = classifyIntersection(plain, grid.xs[col], grid.ys[row], grid.spacing, {
        left: true,
        right: true,
        up: true,
        down: true,
      });
      if (color === 'b') blacks.push({ cx: grid.xs[col], cy: grid.ys[row] });
    }
  }
  const mask = localizeStones(upright.image, plain, blacks, grid.spacing * 0.42);

  const wanted = new Map<string, Pick<Target, 'text' | 'kind' | 'writes'>>();
  expected.moves.forEach((move, index) => {
    const at = pointToSgf(move.point);
    wanted.set(at, { text: move.label ?? String(index + 1), kind: 'label', writes: 'digits' });
  });
  for (const label of expected.labels) {
    wanted.set(pointToSgf(label.point), { text: label.text, kind: 'label', writes: 'letter' });
  }
  // A mark and a number never share a point: a book draws one or the other on a stone.
  for (const mark of expected.marks) {
    wanted.set(pointToSgf(mark.point), { text: mark.shape, kind: 'mark', writes: 'shape' });
  }

  const printed = printedStones(expected);
  const targets: Target[] = [];
  for (const [coord, { text, kind, writes }] of wanted) {
    const column = 'abcdefghijklmnopqrs'.indexOf(coord[0]) - grid.region.left;
    const row = 'abcdefghijklmnopqrs'.indexOf(coord[1]) - grid.region.top;
    if (column < 0 || row < 0 || column >= grid.region.cols || row >= grid.region.rows) continue;

    const x = grid.xs[column];
    const y = grid.ys[row];

    // Whose stone this is comes from the fixture, not from the detector.
    //
    // It decides how the glyph is cut — a number on a black stone is white ink inside a dark
    // disc and comes away inverted — so getting it wrong does not merely mislabel the sample,
    // it produces the wrong shape and the sample is dropped. Asking the detector was near
    // enough while every drawn board was white paper. It stopped being so the moment the
    // generator learned to draw wood, where the detector reads white stones as empty points:
    // the glyph set fell from thirty-six thousand samples to eight, and the ones it lost were
    // exactly the hard ones worth having.
    const color = (printed.get(pointKey({ x: column + grid.region.left, y: row + grid.region.top })) ??
      null) as StoneColor | null;

    targets.push({ coord, text, kind, writes, color, x, y });
  }

  return { name, mask, grid, targets };
}
