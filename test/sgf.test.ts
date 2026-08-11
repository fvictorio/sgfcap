import { describe, expect, it } from 'vitest';
import { finalStones, parseSgf, pointToSgf, serializeSgf, type SgfPosition } from '../src/sgf.js';
import type { Point } from '../src/types.js';

/**
 * The fixtures compare a reading against whatever `parseSgf` says the expected file
 * means, so a bug in here would quietly change what those tests assert. The board rules
 * in particular are exercised by no fixture yet.
 */

const coords = (points: Point[]) => points.map(pointToSgf).sort();

/** Every stone left standing, as e.g. `["aab", "bbw"]`. */
const board = (position: SgfPosition) =>
  [...finalStones(position)]
    .map(([key, color]) => {
      const [x, y] = key.split(',').map(Number);
      return `${pointToSgf({ x, y })}${color}`;
    })
    .sort();

describe('parseSgf', () => {
  it('keeps moves separate from setup stones', () => {
    const position = parseSgf('(;SZ[19]AB[aa];W[bb])');

    expect(coords(position.black)).toEqual(['aa']);
    expect(position.white).toEqual([]);
    expect(position.moves).toEqual([{ color: 'w', point: { x: 1, y: 1 } }]);
  });

  it('records moves in the order played', () => {
    const position = parseSgf('(;SZ[19];B[dd];W[pd];B[dp];W[pp])');

    expect(position.moves.map((move) => `${move.color}${pointToSgf(move.point)}`)).toEqual([
      'bdd',
      'wpd',
      'bdp',
      'wpp',
    ]);
  });

  it('honours AE by clearing setup points', () => {
    const position = parseSgf('(;SZ[19]AB[aa][bb];AE[aa])');

    expect(coords(position.black)).toEqual(['bb']);
  });

  it('follows only the main line through a variation', () => {
    const position = parseSgf('(;SZ[19]AB[aa](;B[bb])(;B[cc]))');

    expect(position.moves).toEqual([{ color: 'b', point: { x: 1, y: 1 } }]);
  });

  it('ignores passes', () => {
    expect(parseSgf('(;SZ[19]AB[aa];W[])').moves).toEqual([]);
  });

  // An editor asked to save one game will happily write out the empty board it opened on
  // ahead of the game that was played, and reading that literally gives an empty board of
  // the wrong size. maxiGos does exactly this.
  it('skips past games that hold no position, to the first that does', () => {
    const position = parseSgf('(;SZ[19]AP[editor])(;SZ[9]AB[cc]AW[dd])');

    expect(position.boardSize).toBe(9);
    expect(coords(position.black)).toEqual(['cc']);
    expect(coords(position.white)).toEqual(['dd']);
  });

  it('still takes the first game when that one has a position of its own', () => {
    const position = parseSgf('(;SZ[9]AB[cc])(;SZ[19]AB[dd])');

    expect(position.boardSize).toBe(9);
    expect(coords(position.black)).toEqual(['cc']);
  });

  it('reads the board size, defaulting to 19', () => {
    expect(parseSgf('(;SZ[13]AB[aa])').boardSize).toBe(13);
    expect(parseSgf('(;AB[aa])').boardSize).toBe(19);
  });

  it('survives whitespace and escaped brackets in comments', () => {
    const position = parseSgf('(;\n  SZ[19]\n  AB[aa]\n  C[a \\] bracket]\n)');

    expect(coords(position.black)).toEqual(['aa']);
  });

  it('attaches LB labels to the move played on that point', () => {
    const position = parseSgf('(;SZ[19];B[dd];W[pd]LB[dd:1][pd:2])');

    expect(position.moves.map((move) => move.label)).toEqual(['1', '2']);
  });

  it('gives a label to the last move on a point, not an earlier captured one', () => {
    // A recapture puts two moves on one point; the label describes the stone standing.
    const position = parseSgf('(;SZ[19];B[dd];W[pd];B[dd]LB[dd:3])');

    expect(position.moves.map((move) => move.label)).toEqual([undefined, undefined, '3']);
  });

  it('round-trips what serializeSgf writes, moves included', () => {
    const original: SgfPosition = {
      boardSize: 19,
      black: [{ x: 3, y: 3 }],
      white: [{ x: 15, y: 15 }],
      labels: [],
      marks: [],
      moves: [
        { color: 'b', point: { x: 9, y: 9 } },
        { color: 'w', point: { x: 2, y: 2 } },
      ],
    };

    expect(parseSgf(serializeSgf(original))).toEqual(original);
  });

  it('keeps a label on a point that is not a move separate from the moves', () => {
    const position = parseSgf('(;SZ[19];B[dd]LB[dd:1][fc:a])');

    expect(position.moves.map((move) => move.label)).toEqual(['1']);
    expect(position.labels).toEqual([{ point: { x: 5, y: 2 }, text: 'a' }]);
  });

  it('round-trips point labels alongside move numbers', () => {
    const original: SgfPosition = {
      boardSize: 19,
      black: [],
      white: [],
      labels: [{ point: { x: 5, y: 2 }, text: 'a' }],
      marks: [],
      moves: [{ color: 'b', point: { x: 3, y: 3 }, label: '1' }],
    };

    expect(parseSgf(serializeSgf(original))).toEqual(original);
  });

  it('writes labels into the root when the diagram has no moves at all', () => {
    const sgf = serializeSgf({
      boardSize: 19,
      black: [],
      white: [],
      labels: [{ point: { x: 5, y: 2 }, text: 'a' }],
      marks: [],
      moves: [],
    });

    expect(sgf).toContain('LB[fc:a]');
    expect(parseSgf(sgf).labels).toEqual([{ point: { x: 5, y: 2 }, text: 'a' }]);
  });

  it('reads marks drawn on stones', () => {
    const position = parseSgf('(;SZ[19]AW[od]TR[od]SQ[pd])');

    expect(position.marks).toEqual([
      { point: { x: 14, y: 3 }, shape: 'triangle' },
      { point: { x: 15, y: 3 }, shape: 'square' },
    ]);
  });

  it('round-trips marks', () => {
    const original: SgfPosition = {
      boardSize: 19,
      black: [],
      white: [{ x: 14, y: 3 }],
      labels: [],
      marks: [{ point: { x: 14, y: 3 }, shape: 'triangle' }],
      moves: [],
    };

    expect(parseSgf(serializeSgf(original))).toEqual(original);
    expect(serializeSgf(original)).toContain('TR[od]');
  });

  it('round-trips the numbers printed on the moves', () => {
    // A continuation diagram numbers its first move 11, not 1.
    const original: SgfPosition = {
      boardSize: 19,
      black: [],
      white: [],
      labels: [],
      marks: [],
      moves: [
        { color: 'b', point: { x: 3, y: 3 }, label: '11' },
        { color: 'w', point: { x: 15, y: 3 }, label: '12' },
      ],
    };

    expect(parseSgf(serializeSgf(original))).toEqual(original);
  });

  it('writes the labels onto the last move node, so they show on the finished board', () => {
    const sgf = serializeSgf({
      boardSize: 19,
      black: [],
      white: [],
      labels: [],
      marks: [],
      moves: [
        { color: 'b', point: { x: 3, y: 3 }, label: '1' },
        { color: 'w', point: { x: 15, y: 3 }, label: '2' },
      ],
    });

    expect(sgf).toContain(';W[pd]LB[dd:1][pd:2]');
  });
});

describe('finalStones', () => {
  it('puts played moves on the board alongside setup', () => {
    expect(board(parseSgf('(;SZ[19]AB[aa];W[bb])'))).toEqual(['aab', 'bbw']);
  });

  it('removes a stone captured by a move', () => {
    const position = parseSgf('(;SZ[19]AW[bb]AB[ba][ab][cb];B[bc])');

    expect(board(position)).toEqual(['abb', 'bab', 'bcb', 'cbb']);
  });

  it('removes a whole captured group, not just the stone played against', () => {
    // White aa+ab in the corner has three liberties: ba, bb and ac.
    const position = parseSgf('(;SZ[19]AW[aa][ab]AB[ba][bb];B[ac])');

    expect(board(position)).toEqual(['acb', 'bab', 'bbb']);
  });

  it('treats a file that sets a stone up and one that plays it as the same board', () => {
    expect(board(parseSgf('(;SZ[19]AW[df])'))).toEqual(board(parseSgf('(;SZ[19];W[df])')));
  });
});
