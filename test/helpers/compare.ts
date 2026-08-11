import { finalStones, humanCoord, pointKey, type SgfPosition } from '../../src/sgf.js';
import type { Point, StoneColor } from '../../src/types.js';

export interface PointDiff {
  point: Point;
  expected: StoneColor | null;
  actual: StoneColor | null;
}

export interface MoveDiff {
  /** 1-based move number. */
  number: number;
  expected: string | null;
  actual: string | null;
}

/**
 * Compare two positions by what is actually on the board.
 *
 * Property order, whitespace and the order of coordinates inside AB[]/AW[] are all
 * irrelevant to whether the reading is correct, so this compares point sets rather
 * than SGF text. Moves count as stones here — see `diffMoves` for the order.
 */
export function diffPositions(expected: SgfPosition, actual: SgfPosition): PointDiff[] {
  const expectedStones = finalStones(expected);
  const actualStones = finalStones(actual);

  const diffs: PointDiff[] = [];
  for (const key of new Set([...expectedStones.keys(), ...actualStones.keys()])) {
    const before = expectedStones.get(key) ?? null;
    const after = actualStones.get(key) ?? null;
    if (before === after) continue;

    const [x, y] = key.split(',').map(Number);
    diffs.push({ point: { x, y }, expected: before, actual: after });
  }

  return diffs.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
}

export function formatDiffs(diffs: PointDiff[], boardSize: number): string {
  const describe = (color: StoneColor | null) =>
    color === 'b' ? 'black' : color === 'w' ? 'white' : 'empty';

  return diffs
    .map((d) => `  ${humanCoord(d.point, boardSize)}: expected ${describe(d.expected)}, got ${describe(d.actual)}`)
    .join('\n');
}

/**
 * Compare the move sequences, in order.
 *
 * Stones in the right places with the numbers on them misread is still a misreading, and
 * the board comparison cannot see it — the numbers decide the order, and the order
 * decides what ends up captured.
 *
 * The number itself is compared too, not just the order it implies. It is printed on the
 * board as `LB` markup, so a stone captioned 44 instead of 4 is wrong on screen whatever
 * order it sorts into — and misread numbers can still sort correctly, which is how a
 * diagram numbered "1 1 3 44" once passed this.
 */
export function diffMoves(expected: SgfPosition, actual: SgfPosition): MoveDiff[] {
  const describe = (position: SgfPosition, index: number): string | null => {
    const move = position.moves[index];
    if (!move) return null;

    // A fixture states the numbers by the order it lists the moves in; only a diagram that
    // starts somewhere other than 1 has to spell them out.
    const label = move.label ?? String(index + 1);
    return `${move.color === 'b' ? 'black' : 'white'} ${humanCoord(move.point, position.boardSize)} as ${label}`;
  };

  const diffs: MoveDiff[] = [];
  for (let i = 0; i < Math.max(expected.moves.length, actual.moves.length); i++) {
    const before = describe(expected, i);
    const after = describe(actual, i);
    if (before !== after) diffs.push({ number: i + 1, expected: before, actual: after });
  }

  return diffs;
}

export interface LabelDiff {
  point: Point;
  expected: string | null;
  actual: string | null;
}

/**
 * Compare the letters printed on points that are not moves.
 *
 * Per point rather than as a sequence: these mark places for the prose to refer to and
 * carry no order. Move numbers are not compared here — they ride on the moves, and the
 * sequence comparison already covers them.
 */
export function diffLabels(expected: SgfPosition, actual: SgfPosition): LabelDiff[] {
  const before = new Map(expected.labels.map((label) => [pointKey(label.point), label.text]));
  const after = new Map(actual.labels.map((label) => [pointKey(label.point), label.text]));

  const diffs: LabelDiff[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;

    const [x, y] = key.split(',').map(Number);
    diffs.push({ point: { x, y }, expected: before.get(key) ?? null, actual: after.get(key) ?? null });
  }

  return diffs.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
}

export function formatLabelDiffs(diffs: LabelDiff[], boardSize: number): string {
  const describe = (text: string | null) => (text === null ? 'nothing' : `"${text}"`);

  return diffs
    .map(
      (d) =>
        `  ${humanCoord(d.point, boardSize)}: expected ${describe(d.expected)}, got ${describe(d.actual)}`,
    )
    .join('\n');
}

export interface MarkDiff {
  point: Point;
  expected: string | null;
  actual: string | null;
}

/**
 * Compare the shapes drawn on points.
 *
 * A book marks a stone to talk about it — "the marked stone is short of liberties" — so
 * losing the mark loses what the diagram was about, even though every stone is right.
 */
export function diffMarks(expected: SgfPosition, actual: SgfPosition): MarkDiff[] {
  const before = new Map(expected.marks.map((mark) => [pointKey(mark.point), mark.shape]));
  const after = new Map(actual.marks.map((mark) => [pointKey(mark.point), mark.shape]));

  const diffs: MarkDiff[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;

    const [x, y] = key.split(',').map(Number);
    diffs.push({ point: { x, y }, expected: before.get(key) ?? null, actual: after.get(key) ?? null });
  }

  return diffs.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
}

export function formatMarkDiffs(diffs: MarkDiff[], boardSize: number): string {
  return diffs
    .map(
      (d) =>
        `  ${humanCoord(d.point, boardSize)}: expected ${d.expected ?? 'no mark'}, got ${d.actual ?? 'no mark'}`,
    )
    .join('\n');
}

/**
 * Stones left standing with no liberties.
 *
 * This is the reason diagrams are read as moves rather than as labelled setup stones: a
 * book prints the stone a sequence captures, so treating every stone as setup yields a
 * board that cannot legally exist and that no editor can play on. Replaying the moves
 * lifts it. Any reading that still leaves a dead stone has misread something.
 */
export function stonesWithoutLiberties(position: SgfPosition): Point[] {
  const board = finalStones(position);
  const dead: Point[] = [];

  for (const key of board.keys()) {
    const [x, y] = key.split(',').map(Number);
    if (!hasLiberty(board, position.boardSize, { x, y })) dead.push({ x, y });
  }

  return dead.sort((a, b) => a.y - b.y || a.x - b.x);
}

function hasLiberty(
  board: Map<string, StoneColor>,
  boardSize: number,
  start: Point,
): boolean {
  const color = board.get(`${start.x},${start.y}`);
  if (!color) return true;

  const seen = new Set([`${start.x},${start.y}`]);
  const queue = [start];

  while (queue.length > 0) {
    const point = queue.pop() as Point;

    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const x = point.x + dx;
      const y = point.y + dy;
      if (x < 0 || y < 0 || x >= boardSize || y >= boardSize) continue;

      const key = `${x},${y}`;
      const occupant = board.get(key);
      if (!occupant) return true;
      if (occupant !== color || seen.has(key)) continue;

      seen.add(key);
      queue.push({ x, y });
    }
  }

  return false;
}

export function formatMoveDiffs(diffs: MoveDiff[]): string {
  return diffs
    .map(
      (d) => `  move ${d.number}: expected ${d.expected ?? 'no move'}, got ${d.actual ?? 'no move'}`,
    )
    .join('\n');
}
