import type { StoneColor } from '../types.js';
import { isDark, type BinaryImage } from './binarize.js';

export interface Classification {
  color: StoneColor | null;
  /** 0..1, from how far the measurement sat from the decision boundary. */
  confidence: number;
  /**
   * How much of the grid lines through this point is still visible, or null where there
   * are no lines to look at. Low on an empty point means something is printed over it.
   */
  lineInk: number | null;
  /**
   * Whether this was called a stone only because its lines had vanished, on a rim too faint
   * to decide on its own — see `FAINT_EDGE`.
   *
   * Worth reporting because the other thing that makes lines vanish is a letter printed over
   * them, and something that knows about letters can settle a case this cannot.
   */
  faint: boolean;
}

/** Which of the four grid lines actually continue past this intersection. */
export interface Neighbours {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** Radii as a fraction of line spacing. Stones are drawn at roughly 0.45–0.48. */
const ARM_INNER = 0.3;
const ARM_OUTER = 0.45;
const EDGE_RADIUS = 0.46;

/**
 * The band between the printed number and the stone's edge.
 *
 * Numbers stay within about a third of the spacing even in books that print them large,
 * and the outline sits at 0.46, so this band is the stone's own colour and nothing else.
 */
const BODY_INNER = 0.36;
const BODY_OUTER = 0.44;

/** Ink around the stone's edge. Measured across the fixtures: stones 0.69+, empty 0.20-. */
const EDGE_PRESENT = 0.45;

/**
 * A fainter edge still counts as a stone if the grid lines under it have vanished.
 *
 * Some prints draw white stones with an outline so thin it barely survives scanning — a
 * third of the ring or less. What gives them away is that the lines they sit on stop dead:
 * something opaque is covering them. Neither signal is sufficient alone. The outline fails
 * on faint prints; line occlusion fails in dense clusters, where the test lands on
 * neighbouring stones and reads their ink as an intact line. Together they cover both.
 *
 * Measured across every fixture, this pair rescues four stones and claims nothing that is
 * really empty — lettered points, the obvious hazard, reach only 0.15 of a ring.
 */
const FAINT_EDGE = 0.25;
const HIDDEN_LINES = 0.3;

/** Ink in the body band. Measured: black 0.79+, white 0.50-. */
const BLACK_BODY = 0.65;

/**
 * Decide what sits on one intersection.
 *
 * Two measurements, in order. Ink around the edge says whether a stone is there at all:
 * black stones are solid to their rim and white ones are drawn with an outline, while an
 * empty point has only two thin grid lines crossing. Then ink in the band between the
 * printed number and that edge says which colour, because a black stone is solid there
 * and a white one is bare.
 *
 * The edge is what mainly decides, because judging a stone purely by whether it hides the
 * lines beneath it fails where diagrams are hardest: in a dense cluster that test lands on
 * the neighbouring stones and reads them as intact lines. But a faintly printed outline
 * needs the line test as a second opinion — see `FAINT_EDGE`.
 */
export function classifyIntersection(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  neighbours: Neighbours,
  structure?: BinaryImage,
): Classification {
  const lineInk = armInk(mask, cx, cy, spacing, neighbours);

  // Whether a stone is *there* is asked of the mask that keeps everything darker than the
  // paper, because some books draw a white stone's outline in the same grey as their grid
  // lines — and the ordinary threshold, which has to put that grey somewhere, puts it with
  // the paper. In `2026-08-13_17-52` a whole row of white stones vanishes that way.
  //
  // Only that question, though. Which colour the stone is stays with the ordinary mask:
  // reading the body off a mask where grey counts as ink was measured and it is a disaster,
  // turning two fixtures with stones wrong into twenty-two.
  //
  // It is also read without the one-pixel band the ordinary mask needs. Strokes are thicker
  // already on a mask that keeps grey, so the band buys nothing there and costs plenty:
  // sweeping a pixel either way gathers the stubs of grid line left around an erased letter
  // until a lettered point rings as brightly as a stone. Measured at the radius alone the
  // two separate cleanly — the stones this rescues read 0.94 and 0.98, and nothing that is
  // really empty passes 0.15.
  const edge = Math.max(
    ringInk(mask, cx, cy, spacing * EDGE_RADIUS),
    structure ? ringInk(structure, cx, cy, spacing * EDGE_RADIUS, 0) : 0,
  );
  const hidden = lineInk !== null && lineInk < HIDDEN_LINES;

  if (edge < EDGE_PRESENT && !(edge >= FAINT_EDGE && hidden)) {
    return {
      color: null,
      confidence: margin(EDGE_PRESENT - edge, 0, EDGE_PRESENT),
      lineInk,
      faint: false,
    };
  }

  const faint = edge < EDGE_PRESENT;
  const body = annulusInk(mask, cx, cy, spacing * BODY_INNER, spacing * BODY_OUTER);
  if (body >= BLACK_BODY) {
    return { color: 'b', confidence: margin(body, BLACK_BODY, 1), lineInk, faint };
  }

  return { color: 'w', confidence: margin(BLACK_BODY - body, 0, BLACK_BODY), lineInk, faint };
}

/** Where a stone actually sits, and how big it is drawn. */
export interface StoneEdge {
  x: number;
  y: number;
  radius: number;
}

/** How far the fitted centre may sit from the intersection, in pixels. */
const MAX_STONE_OFFSET = 2;

/** How much of a circle must be ink for it to be the stone's edge. */
const EDGE_COVERAGE = 0.9;

/**
 * Find the circle that is this stone's own edge.
 *
 * Needed because a number set large touches the outline of the stone it is printed on,
 * and the two then come away as one shape that matches no digit. Sampling inside the
 * fitted circle separates them. It also absorbs the pixel or two by which a scanned
 * stone misses the lattice.
 *
 * Both colours are found the same way, by taking the largest circle that is almost
 * entirely ink: on a white stone only the outline qualifies, and on a black one every
 * circle up to the rim does, so the largest is the rim either way.
 */
export function fitStoneEdge(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
): StoneEdge {
  const smallest = spacing * 0.42;
  const largest = spacing * 0.52;

  let best: StoneEdge = { x: cx, y: cy, radius: spacing * EDGE_RADIUS };
  let bestRadius = -1;
  let bestCoverage = 0;

  for (let dy = -MAX_STONE_OFFSET; dy <= MAX_STONE_OFFSET; dy++) {
    for (let dx = -MAX_STONE_OFFSET; dx <= MAX_STONE_OFFSET; dx++) {
      for (let radius = largest; radius >= smallest; radius -= 1) {
        const coverage = ringInk(mask, cx + dx, cy + dy, radius);
        if (coverage < EDGE_COVERAGE) continue;

        // The first that qualifies is the largest for this centre.
        if (radius > bestRadius || (radius === bestRadius && coverage > bestCoverage)) {
          bestRadius = radius;
          bestCoverage = coverage;
          best = { x: cx + dx, y: cy + dy, radius };
        }
        break;
      }
    }
  }

  return best;
}

/** Fraction of pixels in the band between two radii that are ink. */
function annulusInk(
  mask: BinaryImage,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
): number {
  const bound = Math.ceil(outer);
  let ink = 0;
  let total = 0;

  for (let dy = -bound; dy <= bound; dy++) {
    for (let dx = -bound; dx <= bound; dx++) {
      const distance = Math.hypot(dx, dy);
      if (distance < inner || distance > outer) continue;

      total++;
      if (isDark(mask, Math.round(cx + dx), Math.round(cy + dy))) ink++;
    }
  }

  return total === 0 ? 0 : ink / total;
}

/**
 * How much of the grid lines leaving this intersection is still visible, out of the four
 * that a point in the middle of the board has. Returns null at a point with no neighbours.
 *
 * Always four, not however many this point happens to have. Divide by the lines present
 * and the same amount of leftover line reads higher the nearer the board's edge you get: a
 * single surviving arm is a quarter in the middle, a third on the edge and a half in the
 * corner, so a threshold that fits one place cannot fit the others. Measured across the
 * fixtures that is not hypothetical — a letter on the right edge of `2026-08-12_22-56_1`,
 * with one arm of line left beside it, came out at 0.33 where the identical situation
 * inside the board reads 0.25, and it was read as a bare intersection because of it.
 *
 * Counting a direction the board does not have as clear is also the right answer to the
 * question being asked. What both callers want to know is whether something has been
 * printed over this point, and a line that was never there is not in the way.
 */
function armInk(
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
  neighbours: Neighbours,
): number | null {
  const directions: Array<[number, number]> = [];
  if (neighbours.left) directions.push([-1, 0]);
  if (neighbours.right) directions.push([1, 0]);
  if (neighbours.up) directions.push([0, -1]);
  if (neighbours.down) directions.push([0, 1]);
  if (directions.length === 0) return null;

  const inner = spacing * ARM_INNER;
  const outer = spacing * ARM_OUTER;
  let ink = 0;
  let perArm = 0;

  for (let t = inner; t <= outer; t += 1) perArm++;

  for (const [dx, dy] of directions) {
    for (let t = inner; t <= outer; t += 1) {
      const x = cx + dx * t;
      const y = cy + dy * t;
      // Allow a pixel of slack across the line, so rounding and antialiasing do not
      // read a present line as a missing one.
      if (
        isDark(mask, Math.round(x), Math.round(y)) ||
        isDark(mask, Math.round(x + dy), Math.round(y + dx)) ||
        isDark(mask, Math.round(x - dy), Math.round(y - dx))
      ) {
        ink++;
      }
    }
  }

  return perArm === 0 ? null : ink / (4 * perArm);
}

/**
 * Fraction of a circle at `radius` that is ink — a stone outline lights this up.
 *
 * `band` is how far either side of the radius counts as still on the circle. One pixel by
 * default, because an outline never lands exactly where we look for it; pass 0 on a mask
 * permissive enough that the slack would gather things that are not the outline.
 */
function ringInk(mask: BinaryImage, cx: number, cy: number, radius: number, band = 1): number {
  const samples = 96;
  let ink = 0;

  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // Scan a one-pixel band, since the outline never lands exactly on our radius.
    for (let r = radius - band; r <= radius + band; r += 1) {
      if (isDark(mask, Math.round(cx + dx * r), Math.round(cy + dy * r))) {
        ink++;
        break;
      }
    }
  }

  return ink / samples;
}

/** Distance past a threshold, scaled to 0..1. */
function margin(value: number, threshold: number, limit: number): number {
  if (limit === threshold) return 1;
  return Math.min(1, Math.max(0, (value - threshold) / (limit - threshold)));
}
