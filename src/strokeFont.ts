/**
 * A stroke font, for drawing the text a go diagram prints on itself.
 *
 * Books number the played stones and letter the points the prose refers to, so a renderer
 * that cannot draw a character cannot produce a diagram worth testing against. There is no
 * font on the machine and no rasteriser in the dependencies, so the characters are
 * described here as paths and stroked at whatever weight and size they are wanted.
 *
 * Paths live in a box one unit tall — cap height — with y running downwards, and as wide as
 * the glyph's own `width`. Lowercase sits between `X_HEIGHT` and the baseline at 1, with
 * ascenders reaching 0 and descenders `DESCENDER` past the foot. Being strokes rather than
 * outlines is what makes the weight adjustable, which is half the point: a diagram set in a
 * heavy face and the same one set light are different pictures to a detector.
 */

export type StrokePath = ReadonlyArray<readonly [number, number]>;

export interface StrokeGlyph {
  /** Advance width, as a multiple of cap height. */
  width: number;
  paths: StrokePath[];
}

const X_HEIGHT = 0.34;
const DESCENDER = 1.3;

/**
 * A run of points along an ellipse. Angles are degrees, 0 at the right, and because y runs
 * downwards they advance clockwise on the page: 90 is the foot, 270 the top.
 */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 16,
): StrokePath {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

const ring = (cx: number, cy: number, rx: number, ry: number): StrokePath =>
  arc(cx, cy, rx, ry, 0, 360, 24);

/** Lowercase letters that are a bowl beside a stem: b d p q differ only in where each sits. */
function bowlAndStem(bowlX: number, stemX: number, stemTop: number, stemFoot: number): StrokePath[] {
  return [ring(bowlX, (X_HEIGHT + 1) / 2, 0.24, (1 - X_HEIGHT) / 2), [[stemX, stemTop], [stemX, stemFoot]]];
}

/** An n-shaped shoulder: up the stem, over the top, down again. */
function shoulder(left: number, right: number): StrokePath {
  const mid = (left + right) / 2;
  return [
    [left, 1],
    [left, X_HEIGHT + 0.06],
    ...arc(mid, X_HEIGHT + 0.24, (right - left) / 2, 0.24, 180, 360, 8),
    [right, 1],
  ];
}

const DIGITS: Record<string, StrokeGlyph> = {
  '0': { width: 0.6, paths: [ring(0.3, 0.5, 0.24, 0.48)] },
  '1': { width: 0.6, paths: [[[0.09, 0.24], [0.3, 0.03], [0.3, 1]], [[0.08, 1], [0.52, 1]]] },
  '2': {
    width: 0.6,
    paths: [[...arc(0.3, 0.28, 0.23, 0.25, 195, 380), [0.5, 0.42], [0.07, 0.97]], [[0.05, 0.97], [0.56, 0.97]]],
  },
  '3': {
    width: 0.6,
    paths: [arc(0.28, 0.27, 0.21, 0.24, 190, 440), arc(0.28, 0.73, 0.25, 0.26, 275, 520)],
  },
  '4': { width: 0.6, paths: [[[0.42, 0.03], [0.04, 0.71], [0.57, 0.71]], [[0.42, 0.03], [0.42, 1]]] },
  '5': {
    width: 0.6,
    paths: [[[0.5, 0.05], [0.13, 0.05], [0.1, 0.44]], arc(0.29, 0.7, 0.25, 0.29, 265, 470)],
  },
  '6': { width: 0.6, paths: [arc(0.32, 0.52, 0.28, 0.49, 295, 175), ring(0.29, 0.71, 0.23, 0.27)] },
  '7': { width: 0.6, paths: [[[0.04, 0.05], [0.56, 0.05], [0.24, 1]]] },
  '8': { width: 0.6, paths: [ring(0.3, 0.27, 0.2, 0.24), ring(0.3, 0.74, 0.24, 0.25)] },
  '9': { width: 0.6, paths: [ring(0.29, 0.28, 0.23, 0.26), arc(0.26, 0.47, 0.28, 0.5, 355, 475)] },
};

const LOWERCASE: Record<string, StrokeGlyph> = {
  a: {
    width: 0.58,
    paths: [ring(0.27, (X_HEIGHT + 1) / 2, 0.23, (1 - X_HEIGHT) / 2), [[0.5, X_HEIGHT], [0.5, 1]]],
  },
  b: { width: 0.58, paths: bowlAndStem(0.34, 0.1, 0, 1) },
  c: { width: 0.54, paths: [arc(0.29, (X_HEIGHT + 1) / 2, 0.23, (1 - X_HEIGHT) / 2, 55, 305)] },
  d: { width: 0.58, paths: bowlAndStem(0.26, 0.5, 0, 1) },
  e: {
    width: 0.54,
    paths: [
      [[0.06, 0.67], [0.52, 0.67]],
      arc(0.29, (X_HEIGHT + 1) / 2, 0.23, (1 - X_HEIGHT) / 2, 0, -300),
    ],
  },
  f: {
    width: 0.42,
    paths: [[...arc(0.36, 0.16, 0.19, 0.16, 270, 160), [0.17, 1]], [[0.02, X_HEIGHT + 0.04], [0.42, X_HEIGHT + 0.04]]],
  },
  g: {
    width: 0.58,
    paths: [
      ring(0.27, (X_HEIGHT + 1) / 2, 0.23, (1 - X_HEIGHT) / 2),
      [[0.5, X_HEIGHT], [0.5, 1.1], ...arc(0.27, 1.1, 0.23, 0.2, 0, 140, 8)],
    ],
  },
  h: { width: 0.58, paths: [[[0.1, 0], [0.1, 1]], shoulder(0.1, 0.5)] },
  i: { width: 0.24, paths: [[[0.12, X_HEIGHT], [0.12, 1]], [[0.12, X_HEIGHT - 0.22], [0.12, X_HEIGHT - 0.13]]] },
  j: {
    width: 0.3,
    paths: [
      [[0.2, X_HEIGHT], [0.2, 1.1], ...arc(0.02, 1.1, 0.18, 0.18, 0, 130, 8)],
      [[0.2, X_HEIGHT - 0.22], [0.2, X_HEIGHT - 0.13]],
    ],
  },
  k: { width: 0.54, paths: [[[0.1, 0], [0.1, 1]], [[0.5, X_HEIGHT], [0.1, 0.72]], [[0.24, 0.6], [0.52, 1]]] },
  l: { width: 0.24, paths: [[[0.12, 0], [0.12, 1]]] },
  m: { width: 0.86, paths: [[[0.1, 1], [0.1, X_HEIGHT]], shoulder(0.1, 0.46), shoulder(0.46, 0.8)] },
  n: { width: 0.58, paths: [shoulder(0.1, 0.5)] },
  o: { width: 0.58, paths: [ring(0.29, (X_HEIGHT + 1) / 2, 0.24, (1 - X_HEIGHT) / 2)] },
  p: { width: 0.58, paths: bowlAndStem(0.34, 0.1, X_HEIGHT, DESCENDER) },
  q: { width: 0.58, paths: bowlAndStem(0.26, 0.5, X_HEIGHT, DESCENDER) },
  r: {
    width: 0.42,
    paths: [[[0.1, 1], [0.1, X_HEIGHT]], arc(0.3, X_HEIGHT + 0.22, 0.2, 0.22, 180, 290, 8)],
  },
  s: {
    width: 0.48,
    paths: [[[0.44, 0.44], [0.30, 0.36], [0.12, 0.42], [0.10, 0.55], [0.26, 0.65], [0.40, 0.73], [0.42, 0.88], [0.26, 0.97], [0.06, 0.90]]],
  },
  t: { width: 0.4, paths: [[[0.16, 0.08], [0.16, 0.86], [0.36, 1]], [[0.02, X_HEIGHT + 0.02], [0.38, X_HEIGHT + 0.02]]] },
  u: { width: 0.58, paths: [[[0.1, X_HEIGHT], [0.1, 0.76], ...arc(0.3, 0.76, 0.2, 0.24, 180, 0, 8), [0.5, X_HEIGHT]], [[0.5, 0.76], [0.5, 1]]] },
  v: { width: 0.54, paths: [[[0.04, X_HEIGHT], [0.28, 1], [0.52, X_HEIGHT]]] },
  w: { width: 0.82, paths: [[[0.04, X_HEIGHT], [0.22, 1], [0.4, X_HEIGHT + 0.24], [0.58, 1], [0.76, X_HEIGHT]]] },
  x: { width: 0.52, paths: [[[0.05, X_HEIGHT], [0.47, 1]], [[0.47, X_HEIGHT], [0.05, 1]]] },
  y: { width: 0.54, paths: [[[0.04, X_HEIGHT], [0.28, 1]], [[0.52, X_HEIGHT], [0.14, DESCENDER]]] },
  z: { width: 0.5, paths: [[[0.05, X_HEIGHT], [0.45, X_HEIGHT], [0.05, 1], [0.46, 1]]] },
};

const UPPERCASE: Record<string, StrokeGlyph> = {
  A: { width: 0.68, paths: [[[0.03, 1], [0.34, 0.02], [0.65, 1]], [[0.14, 0.66], [0.54, 0.66]]] },
  B: {
    width: 0.64,
    paths: [[[0.1, 1], [0.1, 0.02], [0.38, 0.02]], arc(0.38, 0.27, 0.22, 0.25, 270, 450), [[0.1, 0.52], [0.4, 0.52]], arc(0.4, 0.76, 0.24, 0.24, 270, 450), [[0.1, 1], [0.4, 1]]],
  },
  C: { width: 0.66, paths: [arc(0.34, 0.5, 0.3, 0.48, 50, 310)] },
  D: { width: 0.68, paths: [[[0.1, 0.02], [0.1, 1], [0.3, 1]], arc(0.3, 0.51, 0.32, 0.49, 90, -90), [[0.1, 0.02], [0.3, 0.02]]] },
  E: { width: 0.6, paths: [[[0.52, 0.02], [0.1, 0.02], [0.1, 1], [0.54, 1]], [[0.1, 0.5], [0.44, 0.5]]] },
  F: { width: 0.56, paths: [[[0.52, 0.02], [0.1, 0.02], [0.1, 1]], [[0.1, 0.5], [0.44, 0.5]]] },
  G: { width: 0.7, paths: [[...arc(0.34, 0.5, 0.3, 0.48, 50, 340), [0.62, 0.56], [0.4, 0.56]]] },
  H: { width: 0.68, paths: [[[0.1, 0.02], [0.1, 1]], [[0.58, 0.02], [0.58, 1]], [[0.1, 0.5], [0.58, 0.5]]] },
  I: { width: 0.3, paths: [[[0.15, 0.02], [0.15, 1]], [[0.02, 0.02], [0.28, 0.02]], [[0.02, 1], [0.28, 1]]] },
  J: { width: 0.5, paths: [[[0.36, 0.02], [0.36, 0.8], ...arc(0.18, 0.8, 0.18, 0.2, 0, 150, 8)]] },
  K: { width: 0.64, paths: [[[0.1, 0.02], [0.1, 1]], [[0.58, 0.02], [0.1, 0.56]], [[0.26, 0.4], [0.6, 1]]] },
  L: { width: 0.54, paths: [[[0.1, 0.02], [0.1, 1], [0.52, 1]]] },
  M: { width: 0.82, paths: [[[0.08, 1], [0.08, 0.02], [0.4, 0.72], [0.72, 0.02], [0.72, 1]]] },
  N: { width: 0.7, paths: [[[0.1, 1], [0.1, 0.02], [0.6, 1], [0.6, 0.02]]] },
  O: { width: 0.72, paths: [ring(0.36, 0.5, 0.3, 0.48)] },
  P: { width: 0.6, paths: [[[0.1, 1], [0.1, 0.02], [0.36, 0.02]], arc(0.36, 0.29, 0.24, 0.27, 270, 450), [[0.1, 0.56], [0.36, 0.56]]] },
  Q: { width: 0.72, paths: [ring(0.36, 0.5, 0.3, 0.48), [[0.44, 0.74], [0.68, 1.06]]] },
  R: { width: 0.64, paths: [[[0.1, 1], [0.1, 0.02], [0.36, 0.02]], arc(0.36, 0.29, 0.24, 0.27, 270, 450), [[0.1, 0.56], [0.36, 0.56]], [[0.3, 0.56], [0.6, 1]]] },
  S: { width: 0.6, paths: [[[0.52, 0.16], [0.36, 0.03], [0.14, 0.13], [0.12, 0.32], [0.32, 0.47], [0.50, 0.62], [0.49, 0.86], [0.29, 0.98], [0.06, 0.86]]] },
  T: { width: 0.6, paths: [[[0.02, 0.02], [0.58, 0.02]], [[0.3, 0.02], [0.3, 1]]] },
  U: { width: 0.68, paths: [[[0.08, 0.02], [0.08, 0.72], ...arc(0.34, 0.72, 0.26, 0.28, 180, 0, 10), [0.6, 0.02]]] },
  V: { width: 0.68, paths: [[[0.03, 0.02], [0.34, 1], [0.65, 0.02]]] },
  W: { width: 0.96, paths: [[[0.03, 0.02], [0.25, 1], [0.47, 0.24], [0.69, 1], [0.91, 0.02]]] },
  X: { width: 0.66, paths: [[[0.04, 0.02], [0.6, 1]], [[0.6, 0.02], [0.04, 1]]] },
  Y: { width: 0.64, paths: [[[0.04, 0.02], [0.32, 0.5], [0.6, 0.02]], [[0.32, 0.5], [0.32, 1]]] },
  Z: { width: 0.62, paths: [[[0.05, 0.02], [0.57, 0.02], [0.05, 1], [0.58, 1]]] },
};

/**
 * A space, which is nothing to draw and something to advance past.
 *
 * Width matches what `textWidth` already assumes for a character it does not know, so the
 * two agree. Without it they disagree: `textWidth` leaves room for the gap and `drawText`
 * skips the glyph entirely without moving the pen, so anything set with spaces in it comes
 * out as one run-together word — which is what "go diagram to SGF" did.
 *
 * A diagram never captions a stone with a space. This is for the app's own furniture.
 */
const SPACE: Record<string, StrokeGlyph> = { ' ': { width: 0.5, paths: [] } };

export const STROKE_FONT: Record<string, StrokeGlyph> = {
  ...DIGITS,
  ...LOWERCASE,
  ...UPPERCASE,
  ...SPACE,
};

/**
 * The shapes a book draws on a stone to talk about it, in the same unit box as a character
 * so they can be drawn by the same code. All four of SGF's marks, though only the triangle
 * has ever turned up in a real fixture so far.
 */
export const MARK_SHAPES: Record<string, StrokePath[]> = {
  triangle: [[[0.5, 0.04], [0.96, 0.86], [0.04, 0.86], [0.5, 0.04]]],
  square: [[[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92], [0.08, 0.08]]],
  circle: [ring(0.5, 0.5, 0.44, 0.44)],
  cross: [[[0.08, 0.08], [0.92, 0.92]], [[0.92, 0.08], [0.08, 0.92]]],
};

/** How wide a string sets, in cap heights, at the given letter spacing. */
export function textWidth(text: string, tracking = 0.04): number {
  let width = 0;
  for (const character of text) width += (STROKE_FONT[character]?.width ?? 0.5) + tracking;
  return Math.max(0, width - tracking);
}
