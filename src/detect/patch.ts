/**
 * One intersection of a board, cut out and normalised the same way every time.
 *
 * This is the input a learned reading of an intersection sees: a square window centred on a
 * point, resampled to a fixed size, with the page's own ink and paper levels mapped to fixed
 * numbers. Everything that varies between one scan and the next — how big the board is drawn,
 * how dark the print is, what colour the paper went — is taken out here, so that what reaches
 * a model is only what is actually printed at that point.
 *
 * Deliberately cut from the greyscale image rather than from a binarised mask. Deciding what
 * is ink and what is paper is exactly the judgement that a threshold gets wrong on the hard
 * images — a white stone outlined in the same grey as the grid, a photographed page with a
 * shadow across it — and handing a model the mask would bake that judgement in before the
 * model ever sees the pixels. The levels below rescale; they do not decide.
 *
 * Lives here rather than in `scripts/` because inference in the browser needs exactly this
 * function. Training data and what the reader feeds a model cannot be allowed to drift.
 */
import type { RgbaImage } from '../types.js';
import type { BinaryImage } from './binarize.js';

/** The square a patch is scaled into. */
export const PATCH = 24;

/**
 * How much of the board a patch covers, in line spacings.
 *
 * A stone is drawn at about 0.92 of a spacing across, so anything from 1.0 up holds the
 * whole of one. The margin beyond that is context and it earns its place: whether the four
 * lines run on, whether the neighbours are stones, and how far the thing at the centre
 * overlaps them are all part of telling a crowded cluster apart from a bare crossing.
 *
 * Not much more than that, though. At two spacings the neighbours are as prominent as the
 * point itself and a model has to learn to ignore most of its own input.
 */
export const PATCH_CELLS = 1.5;

/**
 * The luminance a page uses for ink and for paper.
 *
 * Taken as medians of the two sides of the mask's own threshold rather than as the darkest
 * and lightest pixels found, which are noise almost by definition — one dust speck sets the
 * black point for the whole page otherwise.
 */
export interface Levels {
  ink: number;
  paper: number;
}

/** How far apart the two levels must be before they are believed. */
const MIN_CONTRAST = 16;

export function imageLevels(image: RgbaImage, mask: BinaryImage): Levels {
  const dark: number[] = [];
  const light: number[] = [];

  for (let p = 0, i = 0; p < image.width * image.height; p++, i += 4) {
    (mask.dark[p] === 1 ? dark : light).push(luminance(image, i));
  }

  const ink = median(dark);
  const paper = median(light);

  // A page with nothing on it, or one where the split landed somewhere meaningless. Fall
  // back to the full range so that scaling stays monotonic and nothing divides by zero.
  return paper - ink < MIN_CONTRAST ? { ink: 0, paper: 255 } : { ink, paper };
}

/**
 * Cut the window around one intersection into `into`, as `PATCH` by `PATCH` values.
 *
 * Ink comes out at -1 and paper at +1, with everything between scaled linearly and anything
 * outside clamped — so a faint grey outline lands partway rather than being rounded to one
 * side, which is the whole reason for not passing a mask.
 *
 * Sampled bilinearly, because the window is a fraction of a spacing wide and the lattice
 * lands between pixels. Nearest-neighbour on a 20px cell throws away most of the difference
 * between a thin outline and no outline at all.
 *
 * Off the edge of the image reads as paper. A diagram cropped tight to its border has points
 * whose window hangs over the edge, and the alternative — refusing to cut them — loses the
 * outermost line of every tightly cropped board.
 */
export function intersectionPatch(
  image: RgbaImage,
  levels: Levels,
  cx: number,
  cy: number,
  spacing: number,
  into: Float32Array,
  offset = 0,
): void {
  const window = spacing * PATCH_CELLS;
  const step = window / PATCH;
  const left = cx - window / 2 + step / 2;
  const top = cy - window / 2 + step / 2;
  const range = levels.paper - levels.ink;

  for (let y = 0; y < PATCH; y++) {
    for (let x = 0; x < PATCH; x++) {
      const value = bilinear(image, left + x * step, top + y * step, levels.paper);
      const scaled = ((value - levels.ink) / range) * 2 - 1;
      into[offset + y * PATCH + x] = scaled < -1 ? -1 : scaled > 1 ? 1 : scaled;
    }
  }
}

/**
 * Whether the four grid lines through a point run on, as the board says rather than as the
 * crop does — a line cut off by the edge of the picture still continues on the real board.
 *
 * Not used to cut the patch, but recorded beside it: a point on the board's edge genuinely
 * looks different from one in the middle, and a model that is told which it is does not have
 * to infer it from a window that may not show the edge at all.
 */
export function neighbourhood(x: number, y: number, boardSize: number): number[] {
  return [x > 0 ? 1 : 0, x < boardSize - 1 ? 1 : 0, y > 0 ? 1 : 0, y < boardSize - 1 ? 1 : 0];
}

function luminance(image: RgbaImage, at: number): number {
  // Composited over white, so a transparent PNG reads as paper rather than as ink.
  const alpha = image.data[at + 3] / 255;
  const r = image.data[at] * alpha + 255 * (1 - alpha);
  const g = image.data[at + 1] * alpha + 255 * (1 - alpha);
  const b = image.data[at + 2] * alpha + 255 * (1 - alpha);

  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function bilinear(image: RgbaImage, x: number, y: number, outside: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const at = (px: number, py: number) =>
    px < 0 || py < 0 || px >= image.width || py >= image.height
      ? outside
      : luminance(image, (py * image.width + px) * 4);

  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;

  return top * (1 - fy) + bottom * fy;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}
