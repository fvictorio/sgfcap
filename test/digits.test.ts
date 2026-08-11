import { describe, expect, it } from 'vitest';
import { readStoneLabel, stoneGlyphAttempts, type Glyph, type Reader } from '../src/detect/digits.js';
import type { BinaryImage } from '../src/detect/binarize.js';

/**
 * Cutting the characters out of a stone, which is what `digits.ts` is for now that naming
 * them belongs to the classifier.
 *
 * Deliberately model-free. The glyphs here are a tall bar and a square block, and the reader
 * handed in tells them apart by their proportions alone — so what is under test is the
 * geometry: how many characters come off a stone, and in what order. A test that leaned on a
 * trained model to say what it was looking at would fail for two quite different reasons and
 * not distinguish them.
 *
 * The ordering case earns its place. A two digit number printed tight comes away as one shape
 * and has to be cut, and a cut that is made correctly but read right to left turns every 41
 * in a book into a 14.
 */

/** A tall narrow bar, which the reader below calls 1. */
function bar(height: number): string[] {
  return Array.from({ length: height }, () => '.##.');
}

/** A square block, which it calls 4. */
function block(height: number): string[] {
  return Array.from({ length: height }, () => '########');
}

/** Paint a black stone with these shapes printed on it, the way a book prints a number. */
function stoneWith(shapes: string[][], spacing = 48): BinaryImage {
  const size = spacing * 2;
  const centre = spacing;
  const dark = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - centre, y - centre) <= spacing * 0.47) dark[y * size + x] = 1;
    }
  }

  const scale = 2;
  const widths = shapes.map((rows) => rows[0].length * scale);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const height = (shapes[0]?.length ?? 0) * scale;
  let originX = Math.round(centre - total / 2);

  for (const [i, rows] of shapes.entries()) {
    const originY = Math.round(centre - height / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < widths[i]; x++) {
        if (rows[Math.floor(y / scale)][Math.floor(x / scale)] !== '#') continue;
        // Printed in the opposite colour, so a character is a hole in the black stone.
        dark[(originY + y) * size + (originX + x)] = 0;
      }
    }
    originX += widths[i];
  }

  return { width: size, height: size, dark, threshold: 128 };
}

/** Names a glyph by its proportions: narrow is a 1, broad is a 4. */
const byShape: Reader = (glyph: Glyph) => (glyph.width / glyph.height < 0.5 ? '1' : '4');

describe('reading a number off a stone', () => {
  it('reads a single character', () => {
    expect(readStoneLabel(stoneWith([bar(9)]), 48, 48, 48, 'b', byShape)).toBe('1');
  });

  it('keeps two characters in the order they are printed', () => {
    expect(readStoneLabel(stoneWith([bar(9), block(9)]), 48, 48, 48, 'b', byShape)).toBe('14');
  });

  it('does not read 41 as 14', () => {
    expect(readStoneLabel(stoneWith([block(9), bar(9)]), 48, 48, 48, 'b', byShape)).toBe('41');
  });

  it('reports nothing on a plain stone', () => {
    expect(readStoneLabel(stoneWith([]), 48, 48, 48, 'b', byShape)).toBeNull();
  });
});

describe('cutting a stone into characters', () => {
  it('finds one shape where one is printed', () => {
    const attempts = [...stoneGlyphAttempts(stoneWith([bar(9)]), 48, 48, 48, 'b')];
    expect(attempts.some((glyphs) => glyphs.length === 1)).toBe(true);
  });

  it('finds two where two are printed', () => {
    const attempts = [...stoneGlyphAttempts(stoneWith([bar(9), block(9)]), 48, 48, 48, 'b')];
    expect(attempts.some((glyphs) => glyphs.length === 2)).toBe(true);
  });

  it('finds nothing on a plain stone', () => {
    const attempts = [...stoneGlyphAttempts(stoneWith([]), 48, 48, 48, 'b')];
    expect(attempts.every((glyphs) => glyphs.length === 0)).toBe(true);
  });
});
