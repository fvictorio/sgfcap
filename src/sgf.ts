import type { MarkShape, Point, StoneColor } from './types.js';

export interface Move {
  color: StoneColor;
  point: Point;
  /**
   * The number actually printed on the stone, when the diagram showed one.
   *
   * Kept rather than regenerated from the move's position in the sequence, because a
   * continuation diagram numbers its moves 11-20 while they are still the 1st to 10th
   * moves of that diagram. Written out as `LB` markup so the board shows what the page
   * shows.
   */
  label?: string;
}

/** Text printed on a point that is not a move — the letters prose refers to. */
export interface Label {
  point: Point;
  text: string;
}

/**
 * A shape drawn on a point: how books say "the marked stone".
 *
 * SGF has four. Only triangles are recognised so far, but the others parse and serialize,
 * so a file that uses them survives a round trip.
 */
export interface Mark {
  point: Point;
  shape: MarkShape;
}

const MARK_PROPERTIES: Record<string, MarkShape> = {
  TR: 'triangle',
  SQ: 'square',
  CR: 'circle',
  MA: 'cross',
};

/**
 * A diagram: the stones already there, plus the numbered sequence played over them.
 *
 * Numbered stones become moves rather than labelled setup stones because a diagram can
 * show a position that is not legal as a static board — a stone whose last liberty the
 * final move fills is still printed, so recording it as setup produces a board no one
 * can play on. Replaying the moves lifts it, which is what the book means.
 */
export interface SgfPosition {
  boardSize: number;
  /** Setup stones — `AB` / `AW`, or the unnumbered stones of a diagram. */
  black: Point[];
  white: Point[];
  /**
   * `LB` markup on points that are not moves. A move's own number rides on the move, so
   * that it stays attached to the stone it belongs to.
   */
  labels: Label[];
  /** Shapes drawn on points — `TR` and friends. */
  marks: Mark[];
  /** Numbered moves, in the order they were played. */
  moves: Move[];
}

const COORDS = 'abcdefghijklmnopqrs';

/** SGF coordinate letters, e.g. `{x: 3, y: 3}` -> `"dd"`. */
export function pointToSgf(p: Point): string {
  return COORDS[p.x] + COORDS[p.y];
}

export function sgfToPoint(value: string): Point {
  return { x: COORDS.indexOf(value[0]), y: COORDS.indexOf(value[1]) };
}

/**
 * Human-readable coordinate, e.g. `"Q16"` — the form books and players use.
 * Column letter I is skipped, per convention.
 */
export function humanCoord(p: Point, boardSize: number): string {
  const letters = 'ABCDEFGHJKLMNOPQRST';
  return `${letters[p.x] ?? '?'}${boardSize - p.y}`;
}

export function comparePoints(a: Point, b: Point): number {
  return a.y - b.y || a.x - b.x;
}

export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

/**
 * Read SGF text into setup stones and a move sequence.
 *
 * Only the main line is followed — variations are alternatives to what a diagram shows,
 * not part of it.
 */
export function parseSgf(text: string): SgfPosition {
  // The first game that actually holds a position, rather than simply the first game.
  //
  // An SGF file may carry a whole collection of games, and an editor asked to save one will
  // happily write out the empty board it opened on ahead of the game that was played —
  // maxiGos does it, putting a blank 19x19 game ahead of the 9x9 that was actually played.
  // Taking that literally reads the file as an empty board of the wrong size.
  const games = parseTrees(text).map((tree) => collect(mainLine(tree)));

  return games.find(hasPosition) ?? games[0];
}

/** Whether a game says anything about where the stones are. */
function hasPosition(position: SgfPosition): boolean {
  return (
    position.black.length > 0 ||
    position.white.length > 0 ||
    position.moves.length > 0 ||
    position.labels.length > 0 ||
    position.marks.length > 0
  );
}

/**
 * The stones a diagram *draws*, which is not the same as the stones left standing.
 *
 * A book prints every numbered move where it was played, captures and all — that is the
 * point of numbering them. Replay the sequence and some of those stones come off the board,
 * so `finalStones` and the picture genuinely disagree, and which one is wanted depends on
 * the question. Comparing two files asks what position they describe, and wants captures
 * applied. Asking what is printed at a point on the page — labelling a patch cut out of the
 * image, say — wants this, because the ink is there whatever happened later.
 *
 * `2026-08-13_17-11` is a game record with forty-six numbered moves, five of which are
 * captured before the end. Labelling its intersections by the finished position calls five
 * plainly drawn stones empty, two of them with their move numbers still printed on them.
 */
export function printedStones(position: SgfPosition): Map<string, StoneColor> {
  const board = new Map<string, StoneColor>();

  for (const point of position.black) board.set(pointKey(point), 'b');
  for (const point of position.white) board.set(pointKey(point), 'w');
  // No capture check: a later move on the same point covers an earlier one, and nothing else
  // is lifted.
  for (const move of position.moves) board.set(pointKey(move.point), move.color);

  return board;
}

/**
 * The stones actually standing once setup and every move have been applied.
 *
 * Needed because two files can describe the same picture in different ways — a stone
 * may be recorded as `AW[df]` or played as `;W[df]` — so the board they end up at is
 * the only fair basis for comparing them.
 */
export function finalStones(position: SgfPosition): Map<string, StoneColor> {
  const board = new Map<string, StoneColor>();

  for (const point of position.black) board.set(pointKey(point), 'b');
  for (const point of position.white) board.set(pointKey(point), 'w');
  for (const move of position.moves) {
    playStone(board, position.boardSize, move.point, move.color);
  }

  return board;
}

/** Serialize a position, with points sorted so output is stable. */
export function serializeSgf(position: SgfPosition): string {
  const setup = (color: StoneColor, points: Point[]): string => {
    if (points.length === 0) return '';
    const ident = color === 'b' ? 'AB' : 'AW';
    const sorted = [...points].sort(comparePoints);
    return ident + sorted.map((p) => `[${pointToSgf(p)}]`).join('');
  };

  const root =
    `;GM[1]FF[4]CA[UTF-8]AP[sgfcap]SZ[${position.boardSize}]` +
    setup('b', position.black) +
    setup('w', position.white);

  const moves = position.moves.map(
    (move) => `;${move.color === 'b' ? 'B' : 'W'}[${pointToSgf(move.point)}]`,
  );

  // Markup belongs to the node it sits on, so everything goes on the last one — it is
  // there to annotate the finished diagram, which is where the board opens.
  const marks: Label[] = [
    ...position.moves
      .filter((move) => move.label !== undefined)
      .map((move) => ({ point: move.point, text: move.label as string })),
    ...position.labels,
  ].sort((a, b) => comparePoints(a.point, b.point));

  let markup = marks.length
    ? 'LB' + marks.map((m) => `[${pointToSgf(m.point)}:${escapeValue(m.text)}]`).join('')
    : '';

  for (const [ident, shape] of Object.entries(MARK_PROPERTIES)) {
    const points = position.marks
      .filter((mark) => mark.shape === shape)
      .map((mark) => mark.point)
      .sort(comparePoints);

    if (points.length > 0) {
      markup += ident + points.map((point) => `[${pointToSgf(point)}]`).join('');
    }
  }

  if (markup && moves.length > 0) {
    moves[moves.length - 1] += markup;
  }

  return `(${root}${markup && moves.length === 0 ? markup : ''}${moves.join('')})\n`;
}

function escapeValue(text: string): string {
  return text.replace(/([\\\]])/g, '\\$1');
}

/** One node of a game tree: its properties, keyed by identifier. */
interface SgfNode {
  props: Map<string, string[]>;
}

interface SgfTree {
  nodes: SgfNode[];
  children: SgfTree[];
}

/** Recursive-descent parse of `(;A[..];B[..](;C[..])(;D[..]))`. */
function parseTrees(text: string): SgfTree[] {
  let i = 0;

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  const readValue = (): string => {
    let value = '';
    i++; // '['
    while (i < text.length && text[i] !== ']') {
      // A backslash escapes the next character, which is how ']' appears in comments.
      if (text[i] === '\\' && i + 1 < text.length) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      value += text[i];
      i++;
    }
    i++; // ']'
    return value;
  };

  const readNode = (): SgfNode => {
    i++; // ';'
    const props = new Map<string, string[]>();

    for (;;) {
      skipSpace();
      if (i >= text.length || text[i] < 'A' || text[i] > 'Z') break;

      let end = i;
      while (end < text.length && text[end] >= 'A' && text[end] <= 'Z') end++;
      const ident = text.slice(i, end);
      i = end;

      const values: string[] = [];
      for (;;) {
        skipSpace();
        if (i >= text.length || text[i] !== '[') break;
        values.push(readValue());
      }
      props.set(ident, values);
    }

    return { props };
  };

  const readTree = (): SgfTree => {
    skipSpace();
    if (text[i] !== '(') throw new Error('Not an SGF game tree: expected "(".');
    i++;

    const nodes: SgfNode[] = [];
    const children: SgfTree[] = [];

    for (;;) {
      skipSpace();
      if (text[i] === ';') nodes.push(readNode());
      else if (text[i] === '(') children.push(readTree());
      else break;
    }

    skipSpace();
    if (text[i] !== ')') throw new Error('Malformed SGF: unterminated game tree.');
    i++;

    return { nodes, children };
  };

  const trees = [readTree()];
  for (;;) {
    skipSpace();
    if (i >= text.length || text[i] !== '(') break;
    trees.push(readTree());
  }

  return trees;
}

/** Nodes along the first branch at every fork. */
function mainLine(tree: SgfTree): SgfNode[] {
  const nodes = [...tree.nodes];
  let current = tree;

  while (current.children.length > 0) {
    current = current.children[0];
    nodes.push(...current.nodes);
  }

  return nodes;
}

/**
 * Split the main line into setup stones and moves.
 *
 * Setup properties are folded together in order, so a later AE really does clear an
 * earlier AB. Diagrams that interleave setup with moves are not something books do, so
 * setup is treated as one block regardless of which node it appeared in.
 */
function collect(nodes: SgfNode[]): SgfPosition {
  const boardSize = findBoardSize(nodes);
  const setup = new Map<string, StoneColor>();
  const moves: Move[] = [];
  const labelled = new Map<string, string>();
  const marked = new Map<string, MarkShape>();

  for (const node of nodes) {
    for (const value of node.props.get('AB') ?? []) {
      const point = readPoint(value, boardSize);
      if (point) setup.set(pointKey(point), 'b');
    }
    for (const value of node.props.get('AW') ?? []) {
      const point = readPoint(value, boardSize);
      if (point) setup.set(pointKey(point), 'w');
    }
    for (const value of node.props.get('AE') ?? []) {
      const point = readPoint(value, boardSize);
      if (point) setup.delete(pointKey(point));
    }

    for (const value of node.props.get('LB') ?? []) {
      // "point:text", where the text runs to the end — it may contain colons itself.
      const separator = value.indexOf(':');
      if (separator === -1) continue;

      const point = readPoint(value.slice(0, separator), boardSize);
      if (point) labelled.set(pointKey(point), value.slice(separator + 1));
    }

    for (const [ident, shape] of Object.entries(MARK_PROPERTIES)) {
      for (const value of node.props.get(ident) ?? []) {
        const point = readPoint(value, boardSize);
        if (point) marked.set(pointKey(point), shape);
      }
    }

    for (const [ident, color] of [
      ['B', 'b'],
      ['W', 'w'],
    ] as const) {
      for (const value of node.props.get(ident) ?? []) {
        const point = readPoint(value, boardSize);
        if (point) moves.push({ color, point });
      }
    }
  }

  // A label on a move's point annotates the stone standing there — the one played by the
  // last move there, since earlier moves on that point have been captured. Anything else
  // marks a point in its own right.
  const labels: Label[] = [];
  for (const [key, text] of labelled) {
    const move = [...moves].reverse().find((candidate) => pointKey(candidate.point) === key);
    if (move) {
      move.label = text;
    } else {
      const [x, y] = key.split(',').map(Number);
      labels.push({ point: { x, y }, text });
    }
  }
  labels.sort((a, b) => comparePoints(a.point, b.point));

  const marks: Mark[] = [...marked]
    .map(([key, shape]) => {
      const [x, y] = key.split(',').map(Number);
      return { point: { x, y }, shape };
    })
    .sort((a, b) => comparePoints(a.point, b.point));

  const position: SgfPosition = { boardSize, black: [], white: [], labels, marks, moves };
  for (const [key, color] of setup) {
    const [x, y] = key.split(',').map(Number);
    (color === 'b' ? position.black : position.white).push({ x, y });
  }

  position.black.sort(comparePoints);
  position.white.sort(comparePoints);
  return position;
}

function findBoardSize(nodes: SgfNode[]): number {
  for (const node of nodes) {
    const raw = node.props.get('SZ')?.[0];
    if (!raw) continue;
    // Non-square boards use "w:h"; we only deal with square ones.
    const size = Number.parseInt(raw.split(':')[0], 10);
    if (Number.isFinite(size) && size > 0 && size <= COORDS.length) return size;
  }
  return 19;
}

/** Parse a coordinate value, rejecting passes and anything off the board. */
function readPoint(value: string, boardSize: number): Point | null {
  if (value.length < 2) return null; // "" is a pass

  const point = sgfToPoint(value);
  if (point.x < 0 || point.y < 0 || point.x >= boardSize || point.y >= boardSize) return null;
  return point;
}

/**
 * Play a stone, removing anything it captures.
 *
 * Captures matter because a diagram shows the board as it ends up: replaying a capturing
 * move without lifting the dead stones would compare the reading against a board that
 * never existed.
 */
function playStone(
  board: Map<string, StoneColor>,
  boardSize: number,
  point: Point,
  color: StoneColor,
): void {
  board.set(pointKey(point), color);
  const opponent: StoneColor = color === 'b' ? 'w' : 'b';

  for (const neighbour of neighbours(point, boardSize)) {
    if (board.get(pointKey(neighbour)) === opponent) removeIfDead(board, boardSize, neighbour);
  }

  // Self-capture is illegal in most rule sets, but replaying it as written beats
  // leaving a stone on the board that the diagram does not show.
  removeIfDead(board, boardSize, point);
}

function removeIfDead(board: Map<string, StoneColor>, boardSize: number, start: Point): void {
  const color = board.get(pointKey(start));
  if (!color) return;

  const group = new Set<string>();
  const queue = [start];
  group.add(pointKey(start));

  while (queue.length > 0) {
    const point = queue.pop() as Point;

    for (const neighbour of neighbours(point, boardSize)) {
      const key = pointKey(neighbour);
      const occupant = board.get(key);

      if (!occupant) return; // a liberty, so the group lives
      if (occupant !== color || group.has(key)) continue;

      group.add(key);
      queue.push(neighbour);
    }
  }

  for (const key of group) board.delete(key);
}

function neighbours(point: Point, boardSize: number): Point[] {
  const candidates = [
    { x: point.x - 1, y: point.y },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y - 1 },
    { x: point.x, y: point.y + 1 },
  ];

  return candidates.filter((p) => p.x >= 0 && p.y >= 0 && p.x < boardSize && p.y < boardSize);
}
