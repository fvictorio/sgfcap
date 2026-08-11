/**
 * Scoring a reading, rather than passing or failing it.
 *
 * A diagram is right or wrong in degrees. Reading thirty-four of a book's thirty-five move
 * numbers is not the same failure as not finding the board, and a corpus that treats them
 * alike forces every new image to be fixed or deleted the day it arrives — which is exactly
 * how the interesting images get thrown away.
 *
 * The score is the share of a diagram's *claims* that come back intact:
 *
 *     matched / (expected ∪ actual)
 *
 * A claim is one printed thing — a stone at a point in a colour, a move at a point with a
 * number, a letter, a mark. Taking the union means a hallucinated stone costs as much as a
 * missed one, and counting claims rather than intersections keeps the three hundred empty
 * points of a sparse diagram from drowning the twenty that carry something.
 */
import { pointKey, pointToSgf, printedStones, type SgfPosition } from '../../src/sgf.js';

export interface Reading {
  score: number;
  /** Printed but not read. */
  missing: string[];
  /** Read but not printed. */
  spurious: string[];
  /**
   * Stones got wrong, missing and invented alike.
   *
   * Kept apart from the score because they are a different kind of failure. A misread
   * number is one claim among many and the score says so; a stone in the wrong place or
   * missing altogether is the position itself being wrong, and no amount of everything else
   * being right makes up for it.
   */
  stones: string[];
}

/**
 * Everything a diagram says, as comparable strings.
 *
 * Stones come from what the page draws rather than from the position the moves add up to, so
 * a stone placed as setup and the same stone played as a move are the same claim. A move then
 * adds a second claim carrying its number — which is what makes reading the right stone with
 * the wrong number cost something rather than everything.
 *
 * Drawn, not standing, because what is being graded is a reading of a picture. A book prints
 * every numbered move where it was played and leaves it there; replaying the sequence lifts
 * the captured ones, and grading against that asks nothing at all about stones that are
 * plainly in the image — `2026-08-13_17-11` has five, two still carrying their numbers.
 */
export function claims(position: SgfPosition): Set<string> {
  const out = new Set<string>();
  const board = printedStones(position);

  for (const [key, colour] of board) {
    const [x, y] = key.split(',').map(Number);
    out.add(`stone ${pointToSgf({ x, y })} ${colour}`);
  }
  position.moves.forEach((move, i) => {
    out.add(`move ${pointToSgf(move.point)} ${move.label ?? i + 1}`);
  });
  for (const label of position.labels) {
    // A number printed on a stone is one claim about the picture, and SGF has two ways of
    // recording it: as a move carrying that number, or as a setup stone with a label beside
    // it. Editors differ — maxiGos writes `2026-08-20_00-44` the first way and besogo writes
    // `2026-08-20_00-51` the second — and a reading is not wrong for having chosen the other
    // one. What is being graded is what the diagram says, so both come to the same claim.
    //
    // Only on a stone. A number printed on a bare point is something else again, and a
    // letter is a letter wherever it sits.
    const numbered = /^\d+$/.test(label.text) && board.has(pointKey(label.point));
    out.add(
      numbered
        ? `move ${pointToSgf(label.point)} ${label.text}`
        : `label ${pointToSgf(label.point)} ${label.text}`,
    );
  }
  for (const mark of position.marks) {
    out.add(`mark ${pointToSgf(mark.point)} ${mark.shape}`);
  }

  return out;
}

export function scoreReading(expected: SgfPosition, actual: SgfPosition): Reading {
  const want = claims(expected);
  const got = claims(actual);

  const missing = [...want].filter((claim) => !got.has(claim));
  const spurious = [...got].filter((claim) => !want.has(claim));
  const union = want.size + spurious.length;

  return {
    score: union === 0 ? 1 : (want.size - missing.length) / union,
    missing,
    spurious,
    stones: [...missing, ...spurious].filter((claim) => claim.startsWith('stone ')),
  };
}

/** A diagram that could not be read at all scores nothing and is reported as such. */
export const UNREADABLE: Reading = { score: 0, missing: [], spurious: [], stones: [] };
