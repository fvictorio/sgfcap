import { describe, expect, it } from 'vitest';
import { binarize } from '../src/detect/binarize.js';
import { deskewImage, estimateSkew, rotateImage } from '../src/detect/deskew.js';
import { detectGrid } from '../src/detect/grid.js';
import { renderSgf } from '../src/render.js';

/**
 * Only one fixture is actually crooked, so these tilt a clean board by a known amount
 * and check it comes back — including that the grid, which is what the tilt breaks,
 * can be found again afterwards.
 */

const board = () => renderSgf('(;SZ[19]AB[dd][pp][jj]AW[pd][dp][cf])', { cellSize: 26 });

describe('deskewImage', () => {
  it('leaves a board that is already square alone', () => {
    const straight = board();

    expect(deskewImage(straight, binarize(straight)).angle).toBe(0);
  });

  for (const tilt of [-2, -1, 1.5, 3]) {
    it(`straightens a board tilted by ${tilt} degrees`, () => {
      const tilted = rotateImage(board(), tilt);

      const corrected = deskewImage(tilted, binarize(tilted));
      expect(Math.abs(corrected.angle)).toBeGreaterThan(Math.abs(tilt) - 0.4);
      expect(Math.abs(estimateSkew(binarize(corrected.image)))).toBeLessThan(0.3);
    });
  }

  it('shrugs off a tilt too small to smear a line off its lattice position', () => {
    // Not what deskew is for, but worth pinning: fitting the peaks to a lattice tolerates
    // a quarter of a spacing of drift, and a degree or so of tilt stays inside that.
    const tilted = rotateImage(board(), 1.5);

    expect(detectGrid(binarize(tilted), 19).spacing).toBeCloseTo(26, 0);
  });

  it('makes a tilted board readable again', () => {
    const tilted = rotateImage(board(), 3);

    // The grid is what a tilt destroys: the lines smear across several columns, and what
    // comes back is not the board. It need not throw to be wrong — since the reader learned
    // to carry on where the edges contradict the line count, a tilted board comes back as a
    // reading that does not add up rather than as no reading at all.
    let read: ReturnType<typeof detectGrid> | null = null;
    try {
      read = detectGrid(binarize(tilted), 19);
    } catch {
      read = null;
    }
    expect(read === null || !read.sure || Math.abs(read.spacing - 26) > 1).toBe(true);

    const corrected = deskewImage(tilted, binarize(tilted));
    const straight = detectGrid(binarize(corrected.image), 19);
    expect(straight.spacing).toBeCloseTo(26, 0);
    expect(straight.sure).toBe(true);
  });
});
