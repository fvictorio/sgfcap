/**
 * Decoded RGBA pixels, row-major, 4 bytes per pixel.
 *
 * Structurally identical to the DOM's `ImageData`, so a browser caller can pass
 * `ctx.getImageData(...)` straight in — but nothing here depends on the DOM, which
 * is what lets the core run unchanged under Node in the tests.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** length === width * height * 4 */
  readonly data: Uint8ClampedArray;
}

export type StoneColor = 'b' | 'w';

/** Shapes a diagram draws on a point to refer to it. */
export type MarkShape = 'triangle' | 'square' | 'circle' | 'cross';

/** A board intersection in SGF orientation: x = column from the left, y = row from the top, both 0-based. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Which slice of the full board a diagram shows.
 *
 * Book diagrams are usually corner or edge crops, so the detector has to work out
 * where the crop sits on the real board before stone coordinates mean anything.
 * A full board is `{ left: 0, top: 0, cols: 19, rows: 19 }`.
 */
export interface BoardRegion {
  readonly left: number;
  readonly top: number;
  readonly cols: number;
  readonly rows: number;
}

/** What the detector concluded about a single intersection. */
export interface Intersection {
  /** Coordinate on the full board, already offset by the detected region. */
  readonly point: Point;
  readonly color: StoneColor | null;
  /** 0..1. Low values are the first thing to look at when a fixture fails. */
  readonly confidence: number;
  /** The text printed on the stone, when the diagram shows any — usually a move number. */
  readonly label?: string;
  /**
   * A shape drawn on the point instead of text — how books say "the marked stone".
   */
  readonly mark?: MarkShape;
  /**
   * Whether a stone has anything printed on it at all, whether or not it could be read.
   *
   * A blank stone is setup; a stone with a number on it is a move. Knowing which is which
   * matters even when the number itself defeats the reader, because the move sequence can
   * often supply a number that the pixels could not — but only if it knows which stones are
   * asking for one. See `sequence.ts`.
   */
  readonly inked?: boolean;
  /**
   * Every number this stone might be carrying, best first.
   *
   * Kept because the reading of one stone is not independent of the others: the numbers in a
   * diagram form a run and alternate in colour, so a second choice that fits the sequence
   * beats a first choice that breaks it. See `sequence.ts`.
   */
  readonly options?: ReadonlyArray<{ readonly text: string; readonly score: number }>;
}

/**
 * The full intermediate result of reading a diagram.
 *
 * `imageToSgf` is a thin wrapper that serializes this. Everything a failing fixture
 * needs in order to be debuggable lives here rather than being thrown away.
 */
export interface BoardAnalysis {
  readonly boardSize: number;
  readonly region: BoardRegion;
  readonly intersections: readonly Intersection[];
  /** Pixel coordinates of the detected grid lines, for overlay debugging. */
  readonly grid: {
    readonly xs: readonly number[];
    readonly ys: readonly number[];
  };
}

/** Thrown when an image cannot be read as a go diagram at all. */
export class SgfCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SgfCaptureError';
  }
}
