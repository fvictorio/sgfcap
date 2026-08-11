import { finalStones, parseSgf, pointKey, type SgfPosition } from './sgf.js';
import { MARK_SHAPES, STROKE_FONT, type StrokePath } from './strokeFont.js';
import type { Point, RgbaImage } from './types.js';

/**
 * One character ready to draw, in a box one unit tall — cap height — with y downwards.
 *
 * Either outlines to fill or centre lines to stroke, because the two sources of type work
 * differently: a real typeface describes the edge of the ink, while the built-in font
 * describes the path a pen would take. Filling an outline is the faithful one; stroking a
 * skeleton is the one that lets the weight be dialled.
 */
export interface RenderGlyph {
  /** Advance width, as a multiple of cap height. */
  width: number;
  fill?: Array<Array<[number, number]>>;
  stroke?: StrokePath[];
}

/** Where a renderer gets its characters. Returning null falls back to the built-in font. */
export type Typeface = (character: string) => RenderGlyph | null;

/**
 * Renders a position back to pixels.
 *
 * Primarily a debugging aid: when a fixture fails, the test writes expected and
 * actual side by side so the diff can be read as a board instead of as coordinates.
 * It is dependency-free and DOM-free, so the webapp can reuse it later to preview
 * the SGF it just produced.
 */

export interface RenderOptions {
  /** Pixel distance between adjacent lines. */
  cellSize?: number;
  /** Board margin outside the outermost lines. Defaults to one cell. */
  margin?: number;
  /** Points to ring in red — used to mark mismatches. */
  highlight?: readonly Point[];
  /** Paper and ink. Books print black on white; the default is a board to look at. */
  paper?: Rgb;
  ink?: Rgb;
  /**
   * What a white stone is made of, and what its rim is drawn in.
   *
   * Separate from `ink` because the two vary independently in the wild. A printed diagram
   * gives a white stone a rim as dark as its grid lines; a board rendered on wood often
   * gives it almost none, relying on the stone being paler than the board it sits on. The
   * reader leans hard on that rim, so a generator that always draws a crisp one teaches a
   * model that every white stone has one.
   */
  stoneLight?: Rgb;
  stoneEdge?: Rgb;
  /** Grid line thickness in pixels, and how much heavier the outer border is drawn. */
  lineWidth?: number;
  borderWidth?: number;
  /** Stone radius as a fraction of the cell. */
  stoneRadius?: number;
  /** Star point radius as a fraction of the cell; 0 leaves them off. */
  starRadius?: number;
  /** Cap height of printed characters, as a fraction of the cell. */
  textSize?: number;
  /** Stroke weight of printed characters, as a fraction of their cap height. */
  textWeight?: number;
  /** Forward slant of printed characters, in cap heights per unit height. */
  textSlant?: number;
  /** Mark size as a fraction of the cell. */
  markSize?: number;
  /** Which part of the board to draw. Defaults to all of it. */
  region?: { left: number; top: number; cols: number; rows: number };
  /** Draw the move numbers on their stones, as a book does. */
  showMoveNumbers?: boolean;
  /** Where characters come from. Defaults to the built-in stroke font. */
  typeface?: Typeface;
}

export type Rgb = readonly [number, number, number];

const BOARD: Rgb = [222, 184, 122];
const LINE: Rgb = [40, 30, 20];
const BLACK_STONE: Rgb = [20, 20, 20];
const WHITE_STONE: Rgb = [248, 248, 245];
const HIGHLIGHT: Rgb = [220, 40, 40];

export function renderSgf(sgf: string, options: RenderOptions = {}): RgbaImage {
  return renderPosition(parseSgf(sgf), options);
}

export function renderPosition(position: SgfPosition, options: RenderOptions = {}): RgbaImage {
  const cell = options.cellSize ?? 28;
  const margin = options.margin ?? cell;
  const size = position.boardSize;
  const paper = options.paper ?? BOARD;
  const ink = options.ink ?? LINE;
  const light = options.stoneLight ?? WHITE_STONE;
  const lineWidth = options.lineWidth ?? 1;
  const borderWidth = options.borderWidth ?? lineWidth * 2;
  const stoneRadius = (options.stoneRadius ?? 0.47) * cell;
  const starRadius = (options.starRadius ?? 0.1) * cell;
  const textSize = (options.textSize ?? 0.52) * cell;
  const markSize = (options.markSize ?? 0.5) * cell;

  // Only the part of the board asked for, so a corner or an edge diagram can be drawn the
  // way a book crops one.
  const region = options.region ?? { left: 0, top: 0, cols: size, rows: size };
  const width = (region.cols - 1) * cell + margin * 2;
  const height = (region.rows - 1) * cell + margin * 2;

  const image = createImage(width, height, paper);
  const atX = (i: number) => margin + (i - region.left) * cell;
  const atY = (i: number) => margin + (i - region.top) * cell;
  const inside = (p: Point) =>
    p.x >= region.left &&
    p.x < region.left + region.cols &&
    p.y >= region.top &&
    p.y < region.top + region.rows;

  // A line the crop runs through carries on to the edge of the picture; one at the board's
  // own edge stops, and is drawn heavier. That difference is what places a cropped diagram.
  const spanX = [region.left === 0 ? atX(0) : 0, region.left + region.cols === size ? atX(size - 1) : width - 1];
  const spanY = [region.top === 0 ? atY(0) : 0, region.top + region.rows === size ? atY(size - 1) : height - 1];

  for (let i = region.left; i < region.left + region.cols; i++) {
    const thickness = i === 0 || i === size - 1 ? borderWidth : lineWidth;
    fillRect(image, atX(i) - (thickness - 1) / 2, spanY[0], thickness, spanY[1] - spanY[0] + 1, ink);
  }
  for (let i = region.top; i < region.top + region.rows; i++) {
    const thickness = i === 0 || i === size - 1 ? borderWidth : lineWidth;
    fillRect(image, spanX[0], atY(i) - (thickness - 1) / 2, spanX[1] - spanX[0] + 1, thickness, ink);
  }

  if (starRadius > 0) {
    for (const star of starPoints(size)) {
      if (inside(star)) fillCircle(image, atX(star.x), atY(star.y), Math.max(1.5, starRadius), ink);
    }
  }

  // A letter is printed *instead of* the lines, which are erased around it, so it goes down
  // before the stones and takes its patch of board with it.
  //
  // The gap is at least half a cell whatever size the letter is set at. A book clears the
  // lines properly rather than trimming them to the glyph, and a reader that decides
  // whether a point carries a letter by how much line survives around it is entitled to
  // find none: sampling reaches most of the way to the next point, so a tighter gap leaves
  // stubs at exactly the radius it looks at.
  for (const label of position.labels) {
    if (!inside(label.point)) continue;
    fillCircle(image, atX(label.point.x), atY(label.point.y), Math.max(textSize * 0.78, cell * 0.5), paper);
  }

  // Moves are drawn where they end up, so a rendering shows the board as the diagram
  // does rather than only its setup stones.
  const stones = finalStones(position);
  for (const [key, color] of stones) {
    const [x, y] = key.split(',').map(Number);
    if (!inside({ x, y })) continue;

    if (color === 'w') {
      fillCircle(image, atX(x), atY(y), stoneRadius, light);
      strokeCircle(image, atX(x), atY(y), stoneRadius, Math.max(1, lineWidth), options.stoneEdge ?? ink);
    } else {
      fillCircle(image, atX(x), atY(y), stoneRadius, BLACK_STONE);
    }
  }

  const text = (at: Point, characters: string, color: Rgb, maxWidth?: number) =>
    drawText(image, atX(at.x), atY(at.y), characters, {
      size: textSize,
      weight: options.textWeight ?? 0.14,
      slant: options.textSlant ?? 0,
      color,
      typeface: options.typeface,
      maxWidth,
    });

  for (const label of position.labels) {
    if (inside(label.point)) text(label.point, label.text, ink);
  }

  // On a stone, in the stone's opposite colour — the only way it would be legible.
  if (options.showMoveNumbers) {
    position.moves.forEach((move, index) => {
      if (!inside(move.point)) return;
      const on = stones.get(pointKey(move.point));
      // Kept inside the stone's own outline, with a little clearance.
      text(move.point, move.label ?? String(index + 1), on === 'b' ? light : ink, stoneRadius * 1.7);
    });
  }

  for (const mark of position.marks) {
    if (!inside(mark.point)) continue;
    const paths = MARK_SHAPES[mark.shape];
    if (!paths) continue;

    const on = stones.get(pointKey(mark.point));
    for (const path of paths) {
      strokePath(
        image,
        path.map(([x, y]) => [
          atX(mark.point.x) + (x - 0.5) * markSize,
          atY(mark.point.y) + (y - 0.5) * markSize,
        ]),
        Math.max(1, markSize * 0.12),
        on === 'b' ? light : ink,
      );
    }
  }

  for (const p of options.highlight ?? []) {
    if (inside(p)) strokeCircle(image, atX(p.x), atY(p.y), stoneRadius + 2, 2, HIGHLIGHT);
  }

  return image;
}

export interface TextStyle {
  size: number;
  weight: number;
  slant: number;
  color: Rgb;
  typeface?: Typeface;
  /** Widest the string may set before it is scaled down to fit. */
  maxWidth?: number;
}

/** Set a short string centred on a point, the way a diagram captions a stone. */
export function drawText(image: RgbaImage, cx: number, cy: number, characters: string, style: TextStyle): void {
  const tracking = style.typeface ? 0 : 0.04;
  const glyphs = [...characters].map((character) => glyphFor(character, style.typeface));

  const total = Math.max(0, glyphs.reduce((width, glyph) => width + (glyph?.width ?? 0) + tracking, -tracking));

  // A book sets a two-digit number smaller so it still fits the stone, and a three-digit
  // one smaller again. Without this the ends of "35" hang over the rim and come away with
  // the outline, which is a shape no reader should have to cope with.
  const size = style.maxWidth && total * style.size > style.maxWidth ? style.maxWidth / total : style.size;

  let penX = cx - (total * size) / 2;
  // Centred on cap height rather than on the baseline, which is what puts it in the stone.
  const originY = cy - size / 2;

  for (const glyph of glyphs) {
    if (!glyph) continue;

    const place = ([x, y]: readonly [number, number]): [number, number] => [
      penX + (x + (1 - y) * style.slant) * size,
      originY + y * size,
    ];

    // A real typeface hands over closed outlines, which are filled; the built-in one hands
    // over centre lines, which are stroked at whatever weight is asked for.
    if (glyph.fill) fillContours(image, glyph.fill.map((contour) => contour.map(place)), style.color);
    for (const path of glyph.stroke ?? []) {
      strokePath(image, path.map(place), Math.max(1, style.weight * size), style.color);
    }

    penX += (glyph.width + tracking) * size;
  }
}

function glyphFor(character: string, typeface: Typeface | undefined): RenderGlyph | null {
  const drawn = typeface?.(character);
  if (drawn) return drawn;

  const fallback = STROKE_FONT[character];
  return fallback ? { width: fallback.width, stroke: fallback.paths } : null;
}

/**
 * Fill closed contours by the nonzero winding rule, sampled on a subpixel grid.
 *
 * Supersampling rather than a scanline pass: at the sizes a diagram prints its numbers a
 * glyph is twenty pixels tall, so the whole thing costs less than the circle behind it, and
 * counting crossings per sample is much harder to get subtly wrong than tracking spans.
 */
function fillContours(image: RgbaImage, contours: Array<Array<[number, number]>>, color: Rgb): void {
  const samples = 4;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return;

  for (let py = Math.floor(minY); py <= Math.ceil(maxY); py++) {
    for (let px = Math.floor(minX); px <= Math.ceil(maxX); px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;
          if (windingNumber(contours, x, y) !== 0) hits++;
        }
      }
      blendPixel(image, px, py, color, hits / (samples * samples));
    }
  }
}

function windingNumber(contours: Array<Array<[number, number]>>, x: number, y: number): number {
  let winding = 0;

  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [ax, ay] = contour[i];
      const [bx, by] = contour[(i + 1) % contour.length];
      if (ay === by) continue;

      // Which side of the edge the point falls on, for the edges that straddle its row.
      if (ay <= y && by > y) {
        if ((bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding++;
      } else if (by <= y && ay > y) {
        if ((bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) winding--;
      }
    }
  }

  return winding;
}

/** Stroke a polyline with round joins, antialiased by distance to the nearest segment. */
function strokePath(image: RgbaImage, points: Array<[number, number]>, width: number, color: Rgb): void {
  if (points.length === 0) return;

  const radius = width / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const bound = Math.ceil(radius) + 1;
  for (let py = Math.floor(minY - bound); py <= maxY + bound; py++) {
    for (let px = Math.floor(minX - bound); px <= maxX + bound; px++) {
      let nearest = Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        nearest = Math.min(nearest, distanceToSegment(px, py, points[i], points[i + 1]));
      }
      if (points.length === 1) nearest = Math.hypot(px - points[0][0], py - points[0][1]);

      blendPixel(image, px, py, color, radius + 0.5 - nearest);
    }
  }
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared));

  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Place two renderings next to each other in a single image. */
export function sideBySide(left: RgbaImage, right: RgbaImage, gap = 16): RgbaImage {
  const width = left.width + gap + right.width;
  const height = Math.max(left.height, right.height);
  const combined = createImage(width, height, [255, 255, 255]);

  blit(combined, left, 0, 0);
  blit(combined, right, left.width + gap, 0);

  return combined;
}

function starPoints(size: number): Point[] {
  if (size < 9) return [];
  const edge = size >= 13 ? 3 : 2;
  const mid = (size - 1) / 2;
  const lines = size % 2 === 1 ? [edge, mid, size - 1 - edge] : [edge, size - 1 - edge];

  const points: Point[] = [];
  for (const y of lines) {
    for (const x of lines) {
      if (Number.isInteger(x) && Number.isInteger(y)) points.push({ x, y });
    }
  }

  // A 19x19 board conventionally shows all nine; smaller odd boards show the centre too.
  const seen = new Set<string>();
  return points.filter((p) => {
    const key = pointKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createImage(width: number, height: number, background: Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = background[0];
    data[i + 1] = background[1];
    data[i + 2] = background[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function blendPixel(image: RgbaImage, x: number, y: number, color: Rgb, alpha: number): void {
  if (alpha <= 0) return;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;

  const a = Math.min(1, alpha);
  const i = (y * image.width + x) * 4;
  image.data[i] = image.data[i] * (1 - a) + color[0] * a;
  image.data[i + 1] = image.data[i + 1] * (1 - a) + color[1] * a;
  image.data[i + 2] = image.data[i + 2] * (1 - a) + color[2] * a;
  image.data[i + 3] = 255;
}

function fillRect(image: RgbaImage, x: number, y: number, width: number, height: number, color: Rgb): void {
  for (let py = Math.round(y); py < Math.round(y + height); py++) {
    for (let px = Math.round(x); px < Math.round(x + width); px++) {
      blendPixel(image, px, py, color, 1);
    }
  }
}

/** Circles are antialiased by coverage so rendered boards read cleanly at small cell sizes. */
function fillCircle(image: RgbaImage, cx: number, cy: number, radius: number, color: Rgb): void {
  const bound = Math.ceil(radius) + 1;
  for (let py = Math.floor(cy - bound); py <= cy + bound; py++) {
    for (let px = Math.floor(cx - bound); px <= cx + bound; px++) {
      const distance = Math.hypot(px - cx, py - cy);
      blendPixel(image, px, py, color, radius + 0.5 - distance);
    }
  }
}

function strokeCircle(image: RgbaImage, cx: number, cy: number, radius: number, thickness: number, color: Rgb): void {
  const bound = Math.ceil(radius + thickness) + 1;
  for (let py = Math.floor(cy - bound); py <= cy + bound; py++) {
    for (let px = Math.floor(cx - bound); px <= cx + bound; px++) {
      const distance = Math.hypot(px - cx, py - cy);
      const coverage = Math.min(
        distance - (radius - thickness / 2) + 0.5,
        radius + thickness / 2 - distance + 0.5,
      );
      blendPixel(image, px, py, color, coverage);
    }
  }
}

function blit(target: RgbaImage, source: RgbaImage, offsetX: number, offsetY: number): void {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const from = (y * source.width + x) * 4;
      const to = ((y + offsetY) * target.width + (x + offsetX)) * 4;
      target.data[to] = source.data[from];
      target.data[to + 1] = source.data[from + 1];
      target.data[to + 2] = source.data[from + 2];
      target.data[to + 3] = 255;
    }
  }
}
