import { binarize, type BinaryImage } from './binarize.js';
import type { RgbaImage } from '../types.js';

/**
 * Painting out whatever the picture caught around the page.
 *
 * Every other stage assumes it is looking at a diagram: that the background is paper and the
 * dark things on it are ink. A photograph of a book breaks that assumption before anything
 * has run — the desk the book was lying on is in shot, and it is darker than any ink, so the
 * one threshold separating light from dark ends up separating *desk from page* rather than
 * ink from paper. `photo-1` is the case that showed it: the desk fills the top fifth of the
 * frame, so the tallest row in the profile is 1204 dark pixels of a possible 1204, and every
 * cut below is a share of that. The grid lines reach 450 and are never seen. They were not
 * faint; they were being measured against a table.
 *
 * The same thing happens with no table in sight. `with-blue-border` is a diagram inside a
 * blue frame, and the frame does to the threshold exactly what the desk does.
 *
 * What marks the surround is not how dark it is but where it sits: it touches the edge of the
 * picture, and a page photographed whole does not. So it is found by flooding inwards from
 * the border and stopping at the paper.
 *
 * Not through every dark pixel, though — through thick ones. Dark alone lets the flood in
 * wherever the diagram happens to touch its own shadow, and once inside it runs the length of
 * the grid, because a board's lines are one connected dark thing from edge to edge.
 * `screenshot-editor` is a photograph of a screen whose lower right corner falls into shadow;
 * the flood found a way in there and took the bottom third of the board with it. Thickness is
 * what tells the two apart and it is not a subtle difference: a bezel is a slab tens of pixels
 * across, and every dark thing belonging to a diagram — line, stone, digit — is a stroke.
 *
 * Cut back to a rectangle with none of it left, rather than to the box that merely contains
 * the page. A book does not photograph as a rectangle — the page curves, and the desk above
 * it is a wedge, deep on one side and shallow on the other. The box around everything that is
 * not desk still has the shallow end of that wedge lying across its top, and one row that is
 * dark all the way across is enough: it is the tallest thing in the profile by definition,
 * and every cut below is a share of it.
 *
 * Painting the surround out instead was tried and is worse. It leaves the frame the size it
 * was, so a third of the picture becomes an unbroken field of paper, and the second cutoff —
 * the one deciding whether the grey of a printed grid counts as ink — is fitted to whatever
 * the two commonest levels are, which that field is now large enough to decide. On `photo-1`
 * it moved that cutoff from 158 to 134 and lost three of the nineteen vertical lines the
 * untouched picture had already found.
 *
 * So: shrink until no edge of the rectangle touches the surround at all. The page loses a
 * strip where the wedge was deepest, and that strip was table.
 */

/**
 * How far a pixel must sit inside a dark region for that region to count as a slab, as a
 * share of the picture's shorter side.
 *
 * Scaled rather than fixed, because the same board photographed at 400 pixels and at 1600 has
 * lines four times as thick in one as the other, while the bezel around it grows by the same
 * factor. What is being asked is "thick compared with this picture", and nothing here knows
 * the grid spacing yet — that is what the trim exists to make findable.
 *
 * Small, because it only has to tell a stroke from a slab and the gap between those is wide.
 * Reaching further starts refusing real surrounds: the blue frame around `with-blue-border` is
 * ten pixels on a 474-pixel picture, and asked to be thick over a window of twenty-five it is
 * no longer a frame at all and the diagram goes back to being unreadable.
 */
const SLAB_REACH = 1 / 200;

/** How much of the window around a pixel must be dark for it to be inside a slab. */
const SLAB_SOLID = 0.9;

/**
 * The most of a picture, in each direction, that can be surround.
 *
 * Generous, because it is not the thing keeping this honest — the caller reads the picture
 * both ways and keeps whichever finds more board, so an over-eager cut loses on its merits
 * rather than on a number chosen here. What this stops is the pathological case: a diagram
 * whose own border line touches the edge of the frame, where the flood runs along that line
 * and eats the board from the outside in. `photo-1` needs 26% of its height, nearly all of it
 * the table above the page.
 */
const MOST_MARGIN = 0.4;

/** A picture with its surround dealt with, and where its corner sat in the original. */
export interface Trimmed {
  image: RgbaImage;
  left: number;
  top: number;
}

/**
 * The picture cut back clear of its surround, or null if it has none.
 *
 * Null rather than a copy when there is nothing to do, so a caller can tell "nothing found"
 * from "found and cut" without comparing pixels.
 */
export function maskSurround(image: RgbaImage): Trimmed | null {
  const mask = binarize(image);
  const { width, height } = mask;

  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const slab = thickDark(mask);
  const reach = (x: number, y: number): void => {
    const at = y * width + x;
    // Paper stops the flood, and so does anything too thin to be a surround.
    if (outside[at] === 1 || slab[at] !== 1) return;
    outside[at] = 1;
    queue[tail++] = at;
  };

  for (let x = 0; x < width; x++) {
    reach(x, 0);
    reach(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    reach(0, y);
    reach(width - 1, y);
  }
  if (tail === 0) return null;

  while (head < tail) {
    const at = queue[head++];
    const x = at % width;
    const y = (at / width) | 0;
    if (x > 0) reach(x - 1, y);
    if (x < width - 1) reach(x + 1, y);
    if (y > 0) reach(x, y - 1);
    if (y < height - 1) reach(x, y + 1);
  }

  // Shrink the worst-blocked side, one row or column at a time, until none of the four is
  // blocked at all.
  //
  // The worst rather than all of them, which was tried and eats the picture. The sides are not
  // independent: the wedge of table across the top of `photo-1` also sits in the first column,
  // so while the top is being cut back the left is blocked too, and cutting both each round
  // takes 389 columns off the side to remove 389 rows from the top. Cutting only the worst
  // lets the top clear the wedge, at which point the left is clear as well and never moves.
  let left = 0;
  let top = 0;
  let right = width - 1;
  let bottom = height - 1;

  const blocked = (along: 'row' | 'column', at: number): number => {
    let count = 0;
    if (along === 'row') {
      for (let x = left; x <= right; x++) count += outside[at * width + x];
    } else {
      for (let y = top; y <= bottom; y++) count += outside[y * width + at];
    }
    return count;
  };

  // Capped, so a picture whose diagram runs to its own border cannot be eaten from the
  // outside in. Past this the flood has found something that is not a margin.
  const mostRows = Math.floor(height * MOST_MARGIN);
  const mostColumns = Math.floor(width * MOST_MARGIN);

  while (top < bottom && left < right) {
    const sides = [
      { count: blocked('row', top), cut: () => top++ },
      { count: blocked('row', bottom), cut: () => bottom-- },
      { count: blocked('column', left), cut: () => left++ },
      { count: blocked('column', right), cut: () => right-- },
    ];
    const worst = sides.reduce((a, b) => (b.count > a.count ? b : a));
    if (worst.count === 0) break;
    worst.cut();
    if (top + (height - 1 - bottom) > mostRows) return null;
    if (left + (width - 1 - right) > mostColumns) return null;
  }

  if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1) return null;

  const kept = { width: right - left + 1, height: bottom - top + 1 };
  const data = new Uint8ClampedArray(kept.width * kept.height * 4);
  for (let y = 0; y < kept.height; y++) {
    const from = ((top + y) * width + left) * 4;
    data.set(image.data.subarray(from, from + kept.width * 4), y * kept.width * 4);
  }

  return { image: { width: kept.width, height: kept.height, data }, left, top };
}

/**
 * The dark pixels that sit inside something thick, as opposed to somewhere along a stroke.
 *
 * Measured as the share of a square window around each pixel that is dark, which is an
 * erosion by another name and cheaper to compute over a whole picture: one integral image and
 * then four lookups a pixel, whatever the window size.
 */
function thickDark(mask: BinaryImage): Uint8Array {
  const { width, height } = mask;
  const reach = Math.max(2, Math.round(Math.min(width, height) * SLAB_REACH));

  // Row-major sums, one row and column larger so every window has a top-left to subtract.
  const sums = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask.dark[y * width + x];
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - reach);
    const bottom = Math.min(height - 1, y + reach);
    for (let x = 0; x < width; x++) {
      if (mask.dark[y * width + x] !== 1) continue;
      const left = Math.max(0, x - reach);
      const right = Math.min(width - 1, x + reach);
      const dark =
        sums[(bottom + 1) * (width + 1) + right + 1] -
        sums[top * (width + 1) + right + 1] -
        sums[(bottom + 1) * (width + 1) + left] +
        sums[top * (width + 1) + left];
      const area = (bottom - top + 1) * (right - left + 1);
      if (dark >= area * SLAB_SOLID) out[y * width + x] = 1;
    }
  }

  return out;
}
