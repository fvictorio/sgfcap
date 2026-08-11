/**
 * Which real typefaces can the reader actually read?
 *
 *   pnpm faces
 *
 * Renders the same diagram in every installed face and counts the numbers that come back
 * right. Two things come out of it. One is a limitation worth knowing — the reader is good
 * at upright faces and poor at italics, because no book in the corpus prints its numbers
 * slanted. The other is the list in `typefaces.ts` of faces fit to generate fixtures in:
 * a generated test should encode something that must keep working, not something already
 * known to be broken.
 */
import { renderPosition } from '../src/render.js';
import { usableTypefaces } from './typefaces.js';
import { analyzeImage } from '../src/imageToSgf.js';
import { pointToSgf, type SgfPosition } from '../src/sgf.js';

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '17'];

function board(): SgfPosition {
  const position: SgfPosition = { boardSize: 19, black: [], white: [], labels: [], marks: [], moves: [] };
  NUMBERS.forEach((label, i) => {
    position.moves.push({ color: i % 2 === 0 ? 'b' : 'w', point: { x: (i % 6) * 3 + 2, y: Math.floor(i / 6) * 4 + 3 }, label });
  });
  return position;
}

const position = board();
const want = new Map(position.moves.map((m) => [pointToSgf(m.point), m.label!]));

const scores: Array<[number, string]> = [];
for (const face of usableTypefaces()) {
  const image = renderPosition(position, {
    cellSize: 34, margin: 30, paper: [255, 255, 255], showMoveNumbers: true, typeface: face.glyphs,
  });
  let right = 0;
  try {
    const analysis = await analyzeImage(image);
    for (const i of analysis.intersections) {
      const at = pointToSgf(i.point);
      if (want.has(at) && i.label === want.get(at)) right++;
    }
  } catch { /* counts as zero */ }
  scores.push([right / NUMBERS.length, face.name]);
}

scores.sort((a, b) => b[0] - a[0]);
console.log(`${scores.filter(([s]) => s === 1).length} of ${scores.length} faces read perfectly\n`);
for (const [s, n] of scores) console.log(`  ${(s * 100).toFixed(0).padStart(3)}%  ${n}`);
