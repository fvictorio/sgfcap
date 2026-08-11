import type { RgbaImage } from '../types.js';

/**
 * Enlarging a diagram that was printed or scanned too small to read.
 *
 * Nothing here recovers detail that is not in the image — the point is to stop detail that
 * *is* there from being thrown away. Binarizing commits every pixel to ink or paper, and at
 * the size a book prints a three-digit move number the stroke and the gap beside it land on
 * the same pixel, so the commitment is made before anything has had a chance to read the
 * glyph. Resampling first spreads that decision over enough pixels for the threshold to fall
 * between the strokes instead of across them.
 *
 * `sh-smaller` is the same diagram as `sh-big` at 0.58 the size and was the proof: read as
 * given it lost ten move numbers, and enlarged it reads perfectly. The pixels were never the
 * problem.
 */

/**
 * Catmull-Rom, which passes through its samples and so keeps edges crisp.
 *
 * Bilinear would blur the strokes back together — the exact failure being fixed — and
 * Lanczos rings, printing a pale ghost stroke beside every real one that the threshold then
 * has to be taught to ignore.
 */
function weight(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

/** Enlarge by `factor`, sampling the source at pixel centres. */
export function upscale(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const out = new Uint8ClampedArray(width * height * 4);

  // Separable, so the 4x4 kernel costs 4+4 samples per pixel rather than 16. Horizontal
  // first into a float buffer, keeping full precision between the two passes.
  const wide = new Float32Array(width * image.height * 4);
  for (let x = 0; x < width; x++) {
    const sx = (x + 0.5) / factor - 0.5;
    const x0 = Math.floor(sx);
    const w = [weight(sx - x0 + 1), weight(sx - x0), weight(sx - x0 - 1), weight(sx - x0 - 2)];
    const norm = w[0] + w[1] + w[2] + w[3];
    for (let i = 0; i < 4; i++) w[i] /= norm;
    for (let y = 0; y < image.height; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          const px = Math.min(image.width - 1, Math.max(0, x0 - 1 + i));
          sum += w[i] * image.data[(y * image.width + px) * 4 + c];
        }
        wide[(y * width + x) * 4 + c] = sum;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) / factor - 0.5;
    const y0 = Math.floor(sy);
    const w = [weight(sy - y0 + 1), weight(sy - y0), weight(sy - y0 - 1), weight(sy - y0 - 2)];
    const norm = w[0] + w[1] + w[2] + w[3];
    for (let i = 0; i < 4; i++) w[i] /= norm;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          const py = Math.min(image.height - 1, Math.max(0, y0 - 1 + i));
          sum += w[i] * wide[(py * width + x) * 4 + c];
        }
        out[(y * width + x) * 4 + c] = sum;
      }
    }
  }

  return { width, height, data: out };
}
