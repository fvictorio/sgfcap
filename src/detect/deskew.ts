import type { RgbaImage } from '../types.js';
import type { BinaryImage } from './binarize.js';

/**
 * Straightening a diagram that was scanned at an angle.
 *
 * Everything downstream assumes the board is square to the image: the grid is found by
 * summing ink down columns and across rows, and a degree of tilt is enough to smear each
 * line across several columns and destroy the peaks. A degree also rotates the printed
 * numbers, which template matching does not forgive.
 */

/** Tilt beyond this is not a scanning artefact, and searching wider only invites noise. */
const MAX_SKEW = 5;

const COARSE_STEP = 0.5;
const FINE_STEP = 0.05;

/** Below this the correction is not worth resampling the image for. */
const MIN_CORRECTION = 0.15;

/**
 * The angle the board is tilted by, in degrees.
 *
 * Found by trying rotations and keeping the one whose projections are sharpest. Board
 * lines are long, so when they sit square to an axis all of a line's ink falls in one
 * bin and the sum of squares peaks; any tilt spreads it over neighbours and flattens it.
 * Both axes are scored together, so the answer is the one that squares up the whole grid
 * rather than one family of lines.
 */
export function estimateSkew(mask: BinaryImage): number {
  let best = 0;

  // Coarse pass first: scoring every fine angle across the whole range would mean
  // hundreds of passes over the image for an answer that is usually zero.
  for (const step of [COARSE_STEP, FINE_STEP]) {
    const from = step === COARSE_STEP ? -MAX_SKEW : best - COARSE_STEP;
    const to = step === COARSE_STEP ? MAX_SKEW : best + COARSE_STEP;

    let bestScore = -1;
    for (let angle = from; angle <= to + step / 2; angle += step) {
      const score = projectionSharpness(mask, (angle * Math.PI) / 180);
      if (score > bestScore) {
        bestScore = score;
        best = angle;
      }
    }
  }

  return best;
}

/**
 * Straighten the image if it needs it, and report the correction applied.
 *
 * Resampling costs sharpness, so an image already square is handed back untouched.
 */
export function deskewImage(
  image: RgbaImage,
  mask: BinaryImage,
): { image: RgbaImage; angle: number } {
  const angle = estimateSkew(mask);
  if (Math.abs(angle) < MIN_CORRECTION) return { image, angle: 0 };

  // Rotate back by what was measured, which is the tilt the scan introduced.
  return { image: rotateImage(image, -angle), angle };
}

/** How concentrated the ink is when projected onto both axes at this angle. */
function projectionSharpness(mask: BinaryImage, radians: number): number {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const span = mask.width + mask.height;

  const columns = new Float64Array(span * 2 + 1);
  const rows = new Float64Array(span * 2 + 1);

  for (let y = 0; y < mask.height; y++) {
    const offset = y * mask.width;
    for (let x = 0; x < mask.width; x++) {
      if (mask.dark[offset + x] !== 1) continue;
      columns[Math.round(x * cos + y * sin) + span]++;
      rows[Math.round(y * cos - x * sin) + span]++;
    }
  }

  let total = 0;
  for (let i = 0; i < columns.length; i++) {
    total += columns[i] * columns[i] + rows[i] * rows[i];
  }

  return total;
}

/** Rotate about the centre, sampling bilinearly, with anything off the edge left white. */
export function rotateImage(image: RgbaImage, degrees: number): RgbaImage {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = (image.width - 1) / 2;
  const cy = (image.height - 1) / 2;

  const data = new Uint8ClampedArray(image.width * image.height * 4);

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;

      const target = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        data[target + channel] = sampleBilinear(image, sx, sy, channel);
      }
      data[target + 3] = 255;
    }
  }

  return { width: image.width, height: image.height, data };
}

function sampleBilinear(image: RgbaImage, x: number, y: number, channel: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const at = (px: number, py: number): number => {
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return 255; // off-page
    const i = (py * image.width + px) * 4;
    const alpha = image.data[i + 3] / 255;
    return image.data[i + channel] * alpha + 255 * (1 - alpha);
  };

  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;

  return Math.round(top * (1 - fy) + bottom * fy);
}
