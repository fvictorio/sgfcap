import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPosition, sideBySide } from '../../src/render.js';
import type { SgfPosition } from '../../src/sgf.js';
import { formatDiffs, type PointDiff } from './compare.js';
import { writePng } from './png.js';

const OUTPUT_DIR = join(tmpdir(), 'sgfcap');

/**
 * Draw the failure: expected board on the left, what we read on the right, every
 * disagreeing point ringed in red on both. Beats squinting at coordinate lists,
 * and means a failing fixture can be checked without opening an SGF viewer.
 *
 * Returns the path of the written PNG.
 */
export function writeFailureImage(
  name: string,
  expected: SgfPosition,
  actual: SgfPosition,
  diffs: PointDiff[],
): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const highlight = diffs.map((d) => d.point);
  const comparison = sideBySide(
    renderPosition(expected, { highlight }),
    renderPosition(actual, { highlight }),
  );

  const path = join(OUTPUT_DIR, `${name}.png`);
  writePng(path, comparison);
  return path;
}

/** The message a failing fixture prints: what differed, and where to look at it. */
export function describeFailure(
  name: string,
  expected: SgfPosition,
  actual: SgfPosition,
  diffs: PointDiff[],
): string {
  const path = writeFailureImage(name, expected, actual, diffs);

  return [
    `${name}: ${diffs.length} intersection(s) read incorrectly.`,
    formatDiffs(diffs, expected.boardSize),
    '',
    `  expected (left) vs actual (right): ${path}`,
  ].join('\n');
}
