import { describe, expect, it } from 'vitest';
import { binarize } from '../src/detect/binarize.js';
import { BOARD_SIZES, detectGrid } from '../src/detect/grid.js';
import { renderSgf } from '../src/render.js';
import type { RgbaImage } from '../src/types.js';

/**
 * Placing a cropped diagram on the full board.
 *
 * Only one fixture is a crop, so these cut a rendered board down to corners and edges and
 * check it is put back where it came from. What decides it is which board edges are in
 * view: beyond the board's own edge there is nothing, while a crop leaves the
 * perpendicular lines running on to the edge of the picture.
 */

const CELL = 26;

/** A rendered 19x19 board. Lines sit at CELL + i * CELL, with a blank CELL margin. */
const board = () => renderSgf('(;SZ[19]AB[dd][pp]AW[pd][dp])', { cellSize: CELL });

function crop(image: RgbaImage, x0: number, y0: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((y + y0) * image.width + (x + x0)) * 4;
      const to = (y * width + x) * 4;
      data.set(image.data.subarray(from, from + 4), to);
    }
  }

  return { width, height, data };
}

/** Pixel position of board line `i`, and a cut halfway before it. */
const line = (i: number) => CELL + i * CELL;
const cutBefore = (i: number) => line(i) - Math.floor(CELL / 2);

describe('detectGrid', () => {
  it('places a full board as the whole thing', () => {
    const image = board();

    expect(detectGrid(binarize(image), 19).region).toEqual({
      left: 0,
      top: 0,
      cols: 19,
      rows: 19,
    });
  });

  it('places a top-right corner', () => {
    const image = board();
    const cropped = crop(image, cutBefore(9), 0, image.width - cutBefore(9), cutBefore(9));

    expect(detectGrid(binarize(cropped), 19).region).toEqual({
      left: 9,
      top: 0,
      cols: 10,
      rows: 9,
    });
  });

  it('places a bottom-left corner', () => {
    const image = board();
    const cropped = crop(image, 0, cutBefore(6), cutBefore(12), image.height - cutBefore(6));

    expect(detectGrid(binarize(cropped), 19).region).toEqual({
      left: 0,
      top: 6,
      cols: 12,
      rows: 13,
    });
  });

  it('places a full-width strip along the top edge', () => {
    const image = board();
    const cropped = crop(image, 0, 0, image.width, cutBefore(8));

    expect(detectGrid(binarize(cropped), 19).region).toEqual({
      left: 0,
      top: 0,
      cols: 19,
      rows: 8,
    });
  });

  it('finds the grid when most of one axis is buried', () => {
    // A row of white stones erases the line beneath it, and a crowded diagram can lose
    // most of them. What is left along that axis need not look like a board at all: the
    // surviving lines here are evenly spaced three apart, a tidier lattice by any measure
    // taken down that axis alone than the true one with two thirds of it missing. The
    // columns are unambiguous, and a go board's cells are square, which settles it.
    const image = board();
    const buried = { ...image, data: new Uint8ClampedArray(image.data) };
    for (let i = 0; i < 19; i++) {
      if (i % 3 === 0) continue; // Keep every third row, bury the rest.
      const y = CELL + i * CELL;
      for (let dy = -1; dy <= 1; dy++) {
        for (let x = 0; x < image.width; x++) {
          const at = ((y + dy) * image.width + x) * 4;
          buried.data[at] = buried.data[at + 1] = buried.data[at + 2] = 255;
        }
      }
    }

    const grid = detectGrid(binarize(buried), 19);
    expect(grid.region).toEqual({ left: 0, top: 0, cols: 19, rows: 19 });
    expect(grid.spacing).toBeCloseTo(CELL, 0);
  });

  it('reads the board size off the board', () => {
    // A diagram showing both edges of an axis has counted the board: what lies between them
    // is all of it. Nothing else in the picture says how big it is.
    for (const size of [19, 13, 9]) {
      const image = renderSgf(`(;SZ[${size}]AB[dd])`, { cellSize: CELL });
      const grid = detectGrid(binarize(image));

      expect(grid.boardSize).toBe(size);
      expect(grid.region).toEqual({ left: 0, top: 0, cols: size, rows: size });
    }
  });

  it('takes a crop for the largest board, having nothing to go on', () => {
    // A cropped corner of a 19 and of a 13 are the same picture, so the size cannot be read
    // off it. Nineteen is what books print.
    const image = board();
    const cropped = crop(image, 0, 0, cutBefore(8), cutBefore(8));

    expect(detectGrid(binarize(cropped)).boardSize).toBe(19);
  });

  it('does not trust a line count that is not a board', () => {
    // Both edges in view and fifteen lines between them is a misjudged edge, not a fifteen
    // by fifteen board. It used to be refused outright, and that was too strong: a count
    // that cannot be right says the edges cannot say how big the board is, which is the
    // ordinary position for a cropped diagram and no reason to give up on the picture. What
    // it must not do is pass the reading off as settled.
    const image = renderSgf('(;SZ[15]AB[dd])', { cellSize: CELL });

    const grid = detectGrid(binarize(image));
    expect(grid.sure).toBe(false);
    expect(BOARD_SIZES).toContain(grid.boardSize);
  });

  it('refuses a crop with no board edge in view', () => {
    const image = board();
    const cropped = crop(image, cutBefore(4), cutBefore(4), 9 * CELL, 9 * CELL);

    // Nothing in the picture says which part of the board this is, so guessing would
    // put every stone on the wrong point.
    expect(() => detectGrid(binarize(cropped), 19)).toThrow(/neither/);
  });
});
