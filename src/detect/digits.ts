import type { MarkShape, StoneColor } from '../types.js';
import { isDark, type BinaryImage } from './binarize.js';
import { fitStoneEdge } from './stones.js';

/**
 * Cutting the text printed on the board out of the picture.
 *
 * Two kinds. A played stone carries its move number, printed in the opposite colour to
 * the stone — light on black, dark on white. An empty point can carry a letter that the
 * prose refers to, printed in place of the grid lines, which are erased around it.
 *
 * What this file does is find those shapes and hand them over one character at a time:
 * locate the ink, group it into characters, cut a number that has come away fused, and crop
 * each piece to its own box. Naming the character is somebody else's job — `classify.ts` —
 * and the split is deliberate. This part is geometry and holds for any diagram ever printed;
 * that part is recognition and is learned from drawn examples.
 *
 * The two use separate alphabets, because context settles what a glyph can be: a stone is
 * numbered and a bare point is lettered. That removes the confusions that matter most at
 * this size — 6 against b, 9 against g, 0 against o.
 */

/**
 * How far into the stone to look.
 *
 * Books differ in how large they print their numbers, and some fill most of the stone.
 * Sampling too tightly clips the tall ones and distorts them into other digits, so this
 * reaches close to the stone's edge and the outline is rejected afterwards instead.
 */
const GLYPH_RADIUS = 0.42;

/** Pixels to stay clear of the stone's own outline when reading what is printed on it. */
const EDGE_INSET = 2;

/** Never crop tighter than this, or the number itself gets cut. */
const MIN_GLYPH_RADIUS = 0.3;

/** Tighter crops to fall back on, as a share of the fitted stone radius. */
const FALLBACK_SHRINK = [0.85, 0.75];

/**
 * How far out a component's ink may sit on average, as a share of the sampling radius.
 *
 * Stones in a scan do not land exactly on the lattice, so sampling this wide catches a
 * crescent of the stone's own outline. Such an arc follows the rim, putting all of its ink
 * at nearly the full radius: measured across the fixtures, arcs average 0.90-0.97.
 *
 * The margin below that is thinner than it looks. A single centred digit averages 0.60 or
 * less, but the outer digit of a two-digit number sits well off centre and averages over
 * 0.75 — set any tighter and the second half of every wide number is thrown away.
 */
const MAX_MEAN_RADIUS = 0.85;

/** Ink below this is dirt on a scan, not a digit. Unnumbered stones measure 0-3. */
const MIN_GLYPH_INK = 8;

/** Digits smaller than this share of the largest are specks, not digits. */
const MIN_COMPONENT_SHARE = 0.18;

/** Below this many pixels a component is scanning dirt, and never part of a digit. */
const MIN_SPECK = 4;

/** A match this poor means we did not recognise the glyph at all. */
const MIN_TEMPLATE_SCORE = 0.62;

/** How many nearest exemplars get a vote. */
const NEIGHBOURS = 7;

/** Width-to-height at or below which a glyph can only be a 1. */
const ONE_MAX_ASPECT = 0.45;

/**
 * Width-to-height below which a shape on a stone is not a mark.
 *
 * A mark is drawn as wide as it is tall — a square and a circle exactly so, a triangle
 * wider — while a digit is half as wide as it is tall. Normalising throws that away, and
 * what is left of a ring is a ring: a circle mark and a 0 match each other perfectly, and
 * so, well enough, do the bowls of 3, 6, 8 and 9.
 *
 * This matters more than a wrong character would, because the mark is asked about first and
 * a stone that carries one is never examined for a number. A 3 taken for a circle does not
 * merely mislabel that stone, it drops a move out of the sequence and renumbers the rest.
 * Measured across the fixtures: marks run 0.73 to 1.20 and cluster on 1.0, while a digit
 * only reaches this far when its crop has taken in part of the stone's own outline.
 */
const MIN_MARK_ASPECT = 0.8;

/**
 * Width-to-height above which a glyph cannot be a 1, however well it matches one.
 *
 * The 1 is the digit whose character is its proportions, and normalising is what throws
 * proportions away: stretched to fill the grid, a bare stroke becomes a near-solid block —
 * and a near-solid block is also what any lump of ink becomes. So the 1 prototypes are the
 * ones a smudge lands on. A 2 fused to its own white stone's outline matched one at full
 * width, and every way of cutting that blob in half matched two more.
 *
 * Where to put it took two measurements. Every labelled digit in the books runs from 0.08
 * to 0.57 wide, which suggested 0.65 — but the books are a dozen typefaces and there are
 * more than a dozen. Across the fifty real faces installed, a 1 reaches 0.77: the wider
 * ones are the bolds and the monospaces, where slab serifs and a full base bar make the
 * character genuinely broad. At 0.65 those were being refused, and the first move of a
 * generated diagram kept vanishing. The blob it exists to stop measured 1.13.
 */
const ONE_MAX_TEMPLATE_ASPECT = 0.8;

/**
 * Width-to-height above which a glyph is too wide to be one digit.
 *
 * Numbers set tight enough for their digits to touch arrive as one piece, and a merged
 * "20" matches nothing at all, so anything wider than a digit is cut apart — and a cut is
 * preferred to reading the piece whole, because a merged pair does sometimes resemble a
 * single digit. That preference is why this has to sit clear of the widest real digit
 * rather than merely near it: everything above the line gets chopped in half.
 *
 * Measured on the widest crop of every labelled stone, one digit reaches 0.86 — a 4, the
 * broadest of them — while a genuinely fused pair starts at 1.00. Set at 0.85 the 4 fell
 * on the wrong side and was read as "44".
 */
export const MAX_SINGLE_ASPECT = 0.93;

/**
 * How alike two pieces of a cut have to be to pass as digits of one number: the shorter
 * against the taller, and how much of their vertical extent has to coincide.
 */
const MIN_DIGIT_HEIGHT_MATCH = 0.75;
const MIN_DIGIT_OVERLAP = 0.8;

/** Numbers in these diagrams are at most three digits, so two cuts is the most needed. */
const MAX_SPLITS = 2;

/** How many cut positions to try before giving up on splitting a wide glyph. */
const MAX_CUT_TRIES = 8;

/** Ink a column may carry, against the glyph's densest, and still be a gap between digits. */
const MAX_CUT_INK = 0.35;

/**
 * The aspect past which a glyph cannot be a single character, and how much more ink a cut
 * through one that wide may pass through.
 *
 * No digit or letter this reader knows is anywhere near as wide as it is tall — the widest
 * are about 0.8 — so half again beyond that is a pair with room to spare.
 */
const CERTAINLY_TWO = 1.2;
const WIDE_ALLOWANCE = 1.7;

/**
 * How far off centre a component's weight may sit, as a share of the sampling radius.
 *
 * Generous sideways, because the digits of a two-digit number sit beside each other. Tighter
 * vertically, because they share a baseline through the middle of the stone — but not as
 * tight as it looks, because a digit's *ink* is not centred even when the digit is.
 *
 * A 7 is the case that sets this. It is a full-width bar on top and a stroke that thins as
 * it falls, so its weight sits high however carefully it is printed: measured over 412
 * numbered stones, the five most off-centre digits in the whole corpus are all 7s, and the
 * 7 in `2026-08-13_16-40_1` reaches 0.36. What the bound is really for is the crescent of a
 * stone's own outline caught by the crop, and that sits out at the rim around 0.7 — so there
 * is room to clear the one without admitting the other.
 */
const MAX_OFFSET_X = 0.8;
const MAX_OFFSET_Y = 0.45;

/**
 * The same, for a letter on a bare point, where it has to be looser.
 *
 * A number is centred in its stone, so its ink is centred too. A letter is placed by its
 * baseline, which a book sets at or near the intersection — so its ink sits mostly *below*
 * the point, and how far below depends on whether the letter has a descender and how large
 * it is set. The `a` in `2026-08-11_16-58` sits three pixels low on a nine-pixel radius and
 * was thrown out for it, by a bound written for digits.
 */
const MAX_LETTER_OFFSET_Y = 0.55;

/** A glyph lifted off a stone, as a bounding-box-cropped bitmap. */
/**
 * An alternative way of reading one glyph — the trained classifier, where the caller wants
 * it. Passing one bypasses the prototype matching entirely, along with the guards that
 * exist only to prop it up.
 */
export type Reader = (glyph: Glyph, kind: 'digit' | 'letter' | 'mark') => string | null;

export interface Glyph {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Read the label printed on a stone, or null if it carries none.
 *
 * Returns null both for an unmarked stone and for a marked one we failed to read,
 * because the caller cannot act on the difference — the analysis confidence is where
 * an uncertain reading shows up.
 *
 * Only digits are recognised so far. Books also label points with letters, which would
 * come in here as more prototypes and a wider alphabet.
 */
export function readStoneLabel(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  stone: StoneColor,
  reader: Reader,
): string | null {
  const single = (g: Glyph) => reader(g, 'digit');

  for (const glyphs of stoneGlyphAttempts(mask, cx, cy, spacing, stone)) {
    let digits = '';
    let readable = true;

    for (const glyph of glyphs) {
      const text = readGlyph(glyph, 0, single);
      if (text === null) {
        readable = false; // A label we cannot read in full is worse than none.
        break;
      }
      digits += text;
    }

    // A lone 0 is a misread rather than a label: numbering starts at 1, and 0 only ever
    // turns up as the tail of 10, 20 and so on.
    if (readable && Number.parseInt(digits, 10) > 0) return digits;
  }

  return null;
}

/**
 * The glyph pieces a stone's number comes apart into, one array per crop that is tried.
 *
 * Shared with the exemplar generator so that what gets learned is exactly what gets read.
 * A generator that lifts glyphs its own way produces a set the reader never sees, and the
 * mismatch shows up as prototypes that inexplicably fail to match.
 */
export function stoneGlyphAttempts(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  stone: StoneColor,
): Glyph[][] {
  // A white stone is read inside its own fitted outline: a number set large touches that
  // outline, and the two then come away as one shape matching no digit. Black stones are
  // not fitted — adjacent ones merge into a single mass with no boundary to find, and the
  // fit then wanders onto a neighbour and clips a digit off the number.
  const edge =
    stone === 'w'
      ? fitStoneEdge(mask, cx, cy, spacing)
      : { x: cx, y: cy, radius: spacing * GLYPH_RADIUS + EDGE_INSET };

  const fitted = Math.max(spacing * MIN_GLYPH_RADIUS, edge.radius - EDGE_INSET);

  return [1, ...FALLBACK_SHRINK].map((shrink) => {
    const radius = Math.max(spacing * MIN_GLYPH_RADIUS, fitted * shrink);
    // The number is printed in the opposite colour to the stone it sits on.
    return extractGlyphs(mask, edge.x, edge.y, spacing, stone === 'w', radius / spacing);
  });
}

/**
 * Whether a stone has anything printed on it, without asking what.
 *
 * The same crops `readStoneLabel` reads from, asked only whether they came away with
 * anything. A blank stone yields nothing at any of them; one with a number yields shapes
 * whether or not they turn out to be legible.
 */
export function stoneIsInked(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  stone: StoneColor,
): boolean {
  for (const glyphs of stoneGlyphAttempts(mask, cx, cy, spacing, stone)) {
    if (glyphs.length > 0) return true;
  }
  return false;
}

/**
 * Read the letter printed on an empty point, or null if it carries none.
 *
 * Only call this where the grid lines have been erased — the caller checks that. On an
 * ordinary empty point the crossing lines are themselves dark ink, and would be offered
 * up as a glyph.
 */
/**
 * Every letter this point might be carrying, best first.
 *
 * As `readStoneNumbers`, and for the same reason: a diagram letters its points in a run and
 * never twice the same, so the letters constrain each other and the decoder needs the
 * runners-up to make use of that.
 */
export function readPointLetters(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  rank: (glyph: Glyph) => Array<{ label: string; score: number }>,
): Array<{ text: string; score: number }> {
  const glyphs = pointGlyphs(mask, cx, cy, spacing);
  if (glyphs.length !== 1) return [];

  return rank(glyphs[0])
    .slice(0, 8)
    .map(({ label, score }) => ({ text: label, score }));
}

export function readPointLabel(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  reader: Reader,
): string | null {
  const glyphs = pointGlyphs(mask, cx, cy, spacing);
  if (glyphs.length !== 1) return null; // Reference letters are single characters.

  return reader(glyphs[0], 'letter');
}

/**
 * Read the shape drawn on a stone, or null if it carries none.
 *
 * Books mark a stone to talk about it — "the marked stone is short of liberties" — with a
 * triangle inside it, in the opposite colour. That is the same ink a number would be, so
 * it comes off the stone the same way and is matched against its own small alphabet.
 * Tried only after the number, since a stone carries one or the other.
 */
export function readStoneMark(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  stone: StoneColor,
  reader: Reader,
): MarkShape | null {
  for (const glyphs of stoneGlyphAttempts(mask, cx, cy, spacing, stone)) {
    if (glyphs.length !== 1) continue; // A mark is one shape, alone on the stone.

    const shape = reader(glyphs[0], 'mark');
    if (shape !== null) return shape as MarkShape;
  }

  return null;
}

/** As `stoneGlyphAttempts`, for the letter printed on a bare point. */
export function pointGlyphs(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
): Glyph[] {
  return extractGlyphs(mask, cx, cy, spacing, true, GLYPH_RADIUS, true);
}

/**
 * Lift the digit shapes off a stone, split into components and ordered left to right.
 */
export function extractGlyphs(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  inkIsDark: boolean,
  glyphRadius: number = GLYPH_RADIUS,
  asOneCharacter = false,
): Glyph[] {
  const radius = Math.round(spacing * glyphRadius);
  const size = radius * 2 + 1;
  const ink = new Uint8Array(size * size);
  let total = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;

      const dark = isDark(mask, Math.round(cx + dx), Math.round(cy + dy));
      if (dark !== inkIsDark) continue;

      ink[(dy + radius) * size + (dx + radius)] = 1;
      total++;
    }
  }

  if (total < MIN_GLYPH_INK) return [];

  // Discard the outline arcs before grouping, not after: an arc can curl far enough
  // sideways to share columns with a digit, and would then be fused into it.
  const components = findComponents(ink, size, radius).filter(
    (component) =>
      component.pixels.length >= MIN_SPECK && component.meanRadius <= radius * MAX_MEAN_RADIUS,
  );


  // A photocopied digit can come apart — a 5 whose top stroke no longer meets its bowl
  // arrives as two pieces, and the bowl alone reads as a 3. Pieces that overlap
  // horizontally belong to the same digit; the digits of a two-digit number do not.
  const digits = groupByColumn(components);

  // Judged per digit rather than per piece, so that the top stroke of a broken 5 — which
  // on its own sits high on the stone — is not thrown away before it can be reunited.
  const downwards = asOneCharacter ? MAX_LETTER_OFFSET_Y : MAX_OFFSET_Y;
  const centred = digits.filter((digit) => {
    const offsetX = Math.abs(digit.sumX / digit.ink - radius);
    const offsetY = Math.abs(digit.sumY / digit.ink - radius);

    return offsetX <= radius * MAX_OFFSET_X && offsetY <= radius * downwards;
  });
  if (centred.length === 0) return [];

  // Drop specks so a scanning artefact beside a digit does not become a second digit.
  const largest = Math.max(...centred.map((digit) => digit.ink));
  const kept = centred
    .filter((digit) => digit.ink >= largest * MIN_COMPONENT_SHARE)
    .sort((a, b) => a.minX - b.minX);

  // Where the caller knows there is only one character, everything left belongs to it.
  // Print breaks letters as readily as numbers — a b whose bowl no longer meets its stem
  // arrives in two pieces — and unlike a number there is no digit count to reassemble by.
  if (asOneCharacter && kept.length > 1) {
    return [toGlyph(kept.reduce(mergeDigits), size)];
  }

  return kept.map((digit) => toGlyph(digit, size));
}

interface Component {
  pixels: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  sumY: number;
  /** Mean distance of its pixels from the centre of the sampling window. */
  meanRadius: number;
  /** Furthest any of its pixels sits from that centre. */
  maxRadius: number;
}

/** Connected components of ink, 8-connected so diagonal strokes stay in one piece. */
function findComponents(ink: Uint8Array, size: number, centre: number): Component[] {
  const seen = new Uint8Array(ink.length);
  const components: Component[] = [];

  for (let start = 0; start < ink.length; start++) {
    if (ink[start] === 0 || seen[start] === 1) continue;

    const pixels: number[] = [];
    const queue = [start];
    seen[start] = 1;

    let minX = size;
    let maxX = -1;
    let minY = size;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    let sumRadius = 0;
    let maxRadius = 0;

    while (queue.length > 0) {
      const index = queue.pop() as number;
      const x = index % size;
      const y = Math.floor(index / size);

      pixels.push(index);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      const distance = Math.hypot(x - centre, y - centre);
      sumRadius += distance;
      if (distance > maxRadius) maxRadius = distance;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;

          const neighbour = ny * size + nx;
          if (ink[neighbour] === 0 || seen[neighbour] === 1) continue;

          seen[neighbour] = 1;
          queue.push(neighbour);
        }
      }
    }

    components.push({
      pixels,
      minX,
      maxX,
      minY,
      maxY,
      sumX,
      sumY,
      meanRadius: sumRadius / pixels.length,
      maxRadius,
    });
  }

  return components;
}

/** One digit: the pieces it is made of, plus their combined extent. */
interface Digit {
  pixels: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  sumY: number;
  ink: number;
}

/** Fold two pieces into one, keeping the extent of both. */
function mergeDigits(a: Digit, b: Digit): Digit {
  return {
    pixels: [...a.pixels, ...b.pixels],
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    sumX: a.sumX + b.sumX,
    sumY: a.sumY + b.sumY,
    ink: a.ink + b.ink,
  };
}

/**
 * Gather components into digits by horizontal overlap.
 *
 * Printed numbers set their digits side by side without overlapping, so anything that
 * shares a column with a piece already in the group is part of the same digit.
 */
function groupByColumn(components: Component[]): Digit[] {
  const digits: Digit[] = [];

  for (const component of [...components].sort((a, b) => a.minX - b.minX)) {
    const current = digits[digits.length - 1];

    if (current && component.minX <= current.maxX) {
      current.pixels.push(...component.pixels);
      current.maxX = Math.max(current.maxX, component.maxX);
      current.minY = Math.min(current.minY, component.minY);
      current.maxY = Math.max(current.maxY, component.maxY);
      current.sumX += component.sumX;
      current.sumY += component.sumY;
      current.ink += component.pixels.length;
      continue;
    }

    digits.push({
      pixels: [...component.pixels],
      minX: component.minX,
      maxX: component.maxX,
      minY: component.minY,
      maxY: component.maxY,
      sumX: component.sumX,
      sumY: component.sumY,
      ink: component.pixels.length,
    });
  }

  return digits;
}

/**
 * Read a glyph that may in fact be several digits printed tight enough to touch.
 *
 * Where the digits of a number run together they arrive as one piece, and a merged "30"
 * matches nothing. The join is thin, so the vertical ink profile dips there — but the
 * lightest column is not always the right cut, because the bowls of a 3 and a 0 overlap.
 * So candidate cuts are tried lightest first and the one whose *both halves read as
 * digits* is taken. Letting recognition pick the segmentation is what separates a "30"
 * from the two halves of a mangled 0.
 *
 * A piece that came out of a cut may not fall back on being narrow. That shortcut is there
 * for a 1 printed as a bare stroke, which has no shape for a prototype to match — but a
 * cut manufactures narrow pieces whatever it went through, so with the shortcut allowed
 * here any wide blob slices in two and reads as "11". Which is what a 2 fused to its own
 * white stone's outline was being read as. A piece has to be recognised as a character, not
 * merely be the shape a cut leaves behind.
 */
function readGlyph(
  glyph: Glyph,
  depth: number,
  single: (glyph: Glyph, whole: boolean) => string | null,
): string | null {
  const whole = depth === 0;
  const wide = glyph.width / glyph.height > MAX_SINGLE_ASPECT;
  if (!wide || depth >= MAX_SPLITS) return single(glyph, whole);

  for (const cut of candidateCuts(glyph)) {
    const left = cropColumns(glyph, 0, cut - 1);
    const right = cropColumns(glyph, cut, glyph.width - 1);
    if (!left || !right || !onOneLine(left, right)) continue;

    const before = readGlyph(left.glyph, depth + 1, single);
    if (before === null) continue;

    const after = readGlyph(right.glyph, depth + 1, single);
    if (after === null) continue;

    return before + after;
  }

  // No cut worked; the glyph may just be a wide digit.
  return single(glyph, whole);
}

/**
 * Cut a glyph in two at the lightest column near its middle.
 *
 * Used by the exemplar generator, which knows from the fixture how many characters a
 * number has and so can keep cutting until the count is right. It deliberately does not
 * consult the recogniser, unlike `readGlyph`: learning from cuts the recogniser chose
 * would teach it whatever it already believes.
 */
export function splitGlyph(glyph: Glyph): [Glyph, Glyph] | null {
  for (const cut of candidateCuts(glyph)) {
    const left = cropColumns(glyph, 0, cut - 1);
    const right = cropColumns(glyph, cut, glyph.width - 1);
    if (left && right && onOneLine(left, right)) return [left.glyph, right.glyph];
  }

  return null;
}

/** Columns near the middle where a cut might fall, lightest first. */
function candidateCuts(glyph: Glyph): number[] {
  const columns = new Array<number>(glyph.width).fill(0);
  for (let y = 0; y < glyph.height; y++) {
    for (let x = 0; x < glyph.width; x++) {
      if (glyph.pixels[y * glyph.width + x] === 1) columns[x]++;
    }
  }

  // Only near the middle: the lightest column overall is always at the outside edge.
  const from = Math.max(1, Math.floor(glyph.width * 0.3));
  const to = Math.min(glyph.width - 1, Math.ceil(glyph.width * 0.7));

  // Only where the ink actually thins. Two digits printed tight enough to touch still meet
  // at a waist a pixel or two across, so the column between them is nearly empty. Without
  // this the search is free to cut straight through the middle of a character, and given
  // eight tries at it something usually comes back looking like a pair of digits: a 2 fused
  // to its stone's outline was cut into "41" and into "14" depending where.
  // How much ink a cut may pass through, relaxed on a glyph too wide to be one character.
  //
  // The tight allowance is there to stop the search carving a single character in half, and
  // that danger is real — a 2 fused to its stone's outline was cut into "41" and into "14"
  // depending where. But it is a danger for glyphs that might be one character. A shape half
  // again as wide as it is tall is not one, whatever it looks like, and holding it to the
  // same allowance means it is never cut at all: the pairs in `2026-08-13_17-11` share a
  // bottom bar that every vertical cut has to cross, so the best column comes in a whisker
  // over and four perfectly legible numbers come back as one shape and no reading.
  const wide = glyph.width / glyph.height >= CERTAINLY_TWO;
  const allowance = wide ? MAX_CUT_INK * WIDE_ALLOWANCE : MAX_CUT_INK;

  const tallest = Math.max(...columns);
  const cuts: number[] = [];
  for (let x = from; x <= to; x++) {
    if (columns[x] <= tallest * allowance) cuts.push(x);
  }

  return cuts.sort((a, b) => columns[a] - columns[b]).slice(0, MAX_CUT_TRIES);
}

/** Take a column range and crop it back to its own bounding box, or null if it is blank. */
interface Piece {
  glyph: Glyph;
  /** Where its ink starts and ends within the glyph it was cut from. */
  top: number;
  bottom: number;
}

function cropColumns(glyph: Glyph, from: number, to: number): Piece | null {
  let minX = to + 1;
  let maxX = from - 1;
  let minY = glyph.height;
  let maxY = -1;

  for (let y = 0; y < glyph.height; y++) {
    for (let x = from; x <= to; x++) {
      if (glyph.pixels[y * glyph.width + x] !== 1) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const pixels = new Uint8Array(width * height);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      pixels[(y - minY) * width + (x - minX)] = glyph.pixels[y * glyph.width + x];
    }
  }

  return { glyph: { width, height, pixels }, top: minY, bottom: maxY };
}

/**
 * Whether two pieces could be the neighbouring digits of one number.
 *
 * They have to sit on one line at one size, because that is what printing a number means.
 * The alternative is to accept any cut whose halves each resemble a digit, and almost
 * anything does: a circle drawn on a stone divides into "43", a square into "13", and a 2
 * fused to its stone's own outline into "41". Every one of those cuts pairs a piece of the
 * character with a piece of something else, and the two never line up.
 *
 * Deliberately loose. Real numbers are not typeset perfectly once they have been through a
 * scanner — a 1 beside a 7 can lose a row at either end — so this is here to reject halves
 * of unrelated things, not to hold print to a standard.
 */
function onOneLine(left: Piece, right: Piece): boolean {
  const shorter = Math.min(left.glyph.height, right.glyph.height);
  const taller = Math.max(left.glyph.height, right.glyph.height);
  if (shorter < taller * MIN_DIGIT_HEIGHT_MATCH) return false;

  const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) + 1;
  return overlap >= shorter * MIN_DIGIT_OVERLAP;
}

/**
 * Crop a digit to its own bounding box, so that where it sat on the stone and how large
 * it was printed stop mattering — only its shape is compared.
 */
function toGlyph(digit: Digit, size: number): Glyph {
  const width = digit.maxX - digit.minX + 1;
  const height = digit.maxY - digit.minY + 1;
  const pixels = new Uint8Array(width * height);

  for (const index of digit.pixels) {
    const x = (index % size) - digit.minX;
    const y = Math.floor(index / size) - digit.minY;
    pixels[y * width + x] = 1;
  }

  return { width, height, pixels };
}







/** How many readings of one stone to carry forward. */
const MAX_OPTIONS = 6;

/**
 * How far below the best a character may score and still be worth carrying forward.
 *
 * Generous, because what prunes here cannot be recovered later and the decoder downstream is
 * better placed to judge. `itb-01` prints a 10 whose leading 1 the net reads as a 4 at 0.66
 * against 0.31 — and at the 0.55 this used to sit at, the 1 fell below the cut, the candidate
 * `10` never formed, and the sequence was left knowing that a 10 was missing and that this
 * was the stone missing a number, with no way to join the two. Nothing downstream can undo a
 * reading that was never offered.
 *
 * The guards that matter live in `sequence.ts`, where a candidate has to beat the alternatives
 * on both sides before it is acted on. Loosening this feeds those guards; it does not weaken
 * them. Measured across the corpus anywhere from 0.25 to 0.35 reads the same, and 0.15 starts
 * to invent.
 */
const OPTION_FLOOR = 0.25;

/** The longest number the reader will try to make out of one run of glyphs. */
const MAX_DIGITS = 3;

/**
 * The narrowest a character is ever printed, as a share of its height.
 *
 * Only here to stop a shape being asked to hold more characters than could physically fit in
 * it. A `1` is the narrow case and reaches 0.18 in `2026-08-20_00-51`, so this sits well under
 * that: it is a floor on the absurd, not an estimate of how wide a digit is.
 */
const MIN_DIGIT_ASPECT = 0.3;

/**
 * Every way a run of glyphs might come apart into characters.
 *
 * `readGlyph` already cuts them for the reader, and the candidates have to be gathered the
 * same way or they are gathered from a different picture. A two digit number printed tight
 * comes away as one shape — `2026-08-13_17-11` fuses the pairs of every one of 22, 30, 32 and
 * 36 — and one shape that is two characters is not any character: the classifier has been
 * taught to call exactly that `nothing`, and duly does, so every candidate scores zero and
 * the sequence is handed nothing to work with on four legible numbers.
 */
function segmentations(glyphs: readonly Glyph[]): Glyph[][] {
  // A number fusing into fewer shapes than it has digits still cannot have more digits than
  // the reader will consider, so what one shape may become is what the others leave spare.
  const allowance = MAX_DIGITS - (glyphs.length - 1);

  let out: Glyph[][] = [[]];
  for (const glyph of glyphs) {
    const next: Glyph[][] = [];
    for (const partial of out) {
      for (const alternative of ways(glyph, allowance)) {
        if (partial.length + alternative.length > MAX_DIGITS) continue;
        next.push([...partial, ...alternative]);
      }
    }
    out = next;
  }

  return out;
}

/**
 * Every count of characters one shape might hold, rather than the one its width implies.
 *
 * Width alone cannot tell how many digits a shape holds, because how wide a digit is printed
 * is a property of the book and not of the digit. `2026-08-20_00-51` numbers 67 moves 71 to
 * 146 on a board 19 pixels to a point, and condenses its digits to fit three of them on a
 * stone: a single digit there is 0.45 as wide as it is tall where the rest of the corpus runs
 * 0.6 to 0.86, and its fused *pairs* come in at 0.91 — under the 0.93 that is supposed to mean
 * "too wide to be one character". So its 34 and 26 and 08 were never cut at all, and its 134
 * and 136 and 144 were cut once and read as two digits.
 *
 * Calibrating the width per diagram was the alternative, and it is the harder question: the
 * glyphs that would have to supply the measurement are the same ones in doubt. So the shape is
 * offered whole and in two and in three and the classifier says which it is. A wrong cut
 * leaves at least one piece that is not a character and scores near zero, a right one leaves
 * digits, and scoring as the weakest link is what makes those two outcomes differ — which is
 * a judgement the classifier is good at and a threshold cannot make without knowing the book.
 */
function ways(glyph: Glyph, allowance: number): Glyph[][] {
  const out: Glyph[][] = [];

  // Still taken whole when it is narrow enough to be one character. Offering the cut as well
  // is meant to catch what the width misses, not to reopen what it gets right.
  if (glyph.width / glyph.height <= MAX_SINGLE_ASPECT) out.push([glyph]);

  for (let count = 2; count <= allowance; count++) {
    // A shape has to be wide enough to hold the characters before it is asked to.
    if (glyph.width < glyph.height * MIN_DIGIT_ASPECT * count) break;
    const cut = into(glyph, count);
    if (cut) out.push(cut);
  }

  return out.length > 0 ? out : [[glyph]];
}

/** Cut a shape into exactly `count` characters at its thinnest columns, or null if it will not. */
function into(glyph: Glyph, count: number): Glyph[] | null {
  const wanted = count - 1;
  const apart = glyph.width / (count + 1);

  const chosen: number[] = [];
  for (const at of candidateCuts(glyph)) {
    // Thinnest first, and far enough from the ones already taken to leave a character between.
    if (chosen.some((other) => Math.abs(other - at) < apart)) continue;
    chosen.push(at);
    if (chosen.length === wanted) break;
  }
  if (chosen.length < wanted) return null;
  chosen.sort((a, b) => a - b);

  const parts: Piece[] = [];
  let from = 0;
  for (const at of [...chosen, glyph.width]) {
    const piece = cropColumns(glyph, from, at - 1);
    if (!piece) return null;
    parts.push(piece);
    from = at;
  }

  // Neighbours have to sit on one line, or the cut has taken a mark off the stone rather than
  // separated two digits.
  for (let i = 1; i < parts.length; i++) {
    if (!onOneLine(parts[i - 1], parts[i])) return null;
  }

  return parts.map((piece) => piece.glyph);
}

/**
 * Every number this stone might be carrying, best first.
 *
 * Built from the ranked characters of each piece the number comes apart into, so a two digit
 * number offers combinations of its two halves' candidates. Scored as the weakest link, since
 * a number is only as well read as its worst digit.
 */
export function readStoneNumbers(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  stone: StoneColor,
  rank: (glyph: Glyph) => Array<{ label: string; score: number }>,
): Array<{ text: string; score: number }> {
  const found = new Map<string, number>();

  for (const glyphs of stoneGlyphAttempts(mask, cx, cy, spacing, stone)) {
    if (glyphs.length === 0 || glyphs.length > MAX_DIGITS) continue;

    // Every way the shapes might come apart, all of them read into the same pool. A wrong
    // segmentation leaves a piece the classifier calls nothing and scores near zero, so the
    // pool sorts itself out and `sequence.ts` arbitrates whatever is left standing.
    for (const parts of segmentations(glyphs)) {
      let combinations: Array<{ text: string; score: number }> = [{ text: '', score: 1 }];
      for (const glyph of parts) {
        const options = rank(glyph).slice(0, MAX_OPTIONS);
        if (options.length === 0) {
          combinations = [];
          break;
        }
        const cut = options[0].score * OPTION_FLOOR;
        const next: Array<{ text: string; score: number }> = [];
        for (const partial of combinations) {
          for (const option of options) {
            if (option.score < cut) break;
            next.push({
              text: partial.text + option.label,
              score: Math.min(partial.score, option.score),
            });
          }
        }
        combinations = next.sort((a, b) => b.score - a.score).slice(0, MAX_OPTIONS * 2);
      }

      for (const { text, score } of combinations) {
        if (!/^[0-9]+$/.test(text) || Number.parseInt(text, 10) <= 0) continue;
        found.set(text, Math.max(found.get(text) ?? 0, score));
      }
    }
  }

  return [...found].map(([text, score]) => ({ text, score })).sort((a, b) => b.score - a.score);
}







