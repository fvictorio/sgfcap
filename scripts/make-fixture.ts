/**
 * Generate a synthetic fixture image from an SGF file:
 *
 *   npm run fixture -- test/data/foo.sgf [--cell 28]
 *
 * Writes foo.png next to it. These clean, synthetic boards are the easy end of the
 * difficulty range — a useful first target for the detector and a way to prove the
 * harness works. Real book scans get dropped into test/data by hand.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { renderSgf } from '../src/render.js';
import { writePng } from '../test/helpers/png.js';

const args = process.argv.slice(2);
const sgfPath = args.find((arg) => !arg.startsWith('--'));

if (!sgfPath) {
  console.error('usage: npm run fixture -- <path/to/position.sgf> [--cell <pixels>]');
  process.exit(1);
}

const cellFlag = args.indexOf('--cell');
const cellSize = cellFlag === -1 ? 28 : Number(args[cellFlag + 1]);

const image = renderSgf(readFileSync(sgfPath, 'utf8'), { cellSize });
const pngPath = join(dirname(sgfPath), `${basename(sgfPath, extname(sgfPath))}.png`);

writePng(pngPath, image);
console.log(`wrote ${pngPath} (${image.width}x${image.height})`);
