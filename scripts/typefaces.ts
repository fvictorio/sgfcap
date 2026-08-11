/**
 * Real typefaces, for drawing generated fixtures in something other than my handwriting.
 *
 * Lives in `scripts/` rather than `src/` on purpose: `opentype.js` is a build-time
 * dependency and the browser bundle must not grow a font parser it has no use for. The
 * renderer takes characters through a small interface, and this is one implementation of
 * it — the built-in stroke font being the other, and the fallback when no fonts are
 * installed.
 *
 * Why bother, when a hand-drawn font already worked: because the shapes it draws are my
 * guesses at what print looks like, and glyphs learned from one invented face teach the
 * reader that face. Fifty real ones span serif and sans, condensed and wide, light and
 * bold — and they disagree with each other in exactly the ways real books do. The first
 * generated diagram that failed did so on a serifed 1, a shape no fixture had, and it took
 * a real font to confirm that was a genuine typographic form rather than my invention.
 *
 * Install with:
 *   sudo apt-get install -y fonts-dejavu-core fonts-liberation2 fonts-urw-base35
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
import type { RenderGlyph, Typeface } from '../src/render.js';

const FONT_ROOTS = ['/usr/share/fonts', '/usr/local/share/fonts'];

/** Faces a go book would never set a diagram in — symbol fonts, mostly. */
const SKIP = /Dingbats|Symbol|D050000L|StandardSymbols|Emoji|Music/i;

export interface LoadedTypeface {
  name: string;
  /** Ready to hand to `renderPosition`. */
  glyphs: Typeface;
}

export function availableFonts(): string[] {
  const found: string[] = [];

  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ttf|otf)$/i.test(entry.name) && !SKIP.test(entry.name)) found.push(path);
    }
  };

  for (const root of FONT_ROOTS) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // Not installed; the caller falls back to the built-in font.
    }
  }

  return found.sort();
}

/**
 * Load a font and expose its characters in the renderer's box: one unit tall from cap
 * height to baseline, y downwards, x from the pen position.
 *
 * Everything is scaled by cap height rather than em size, because that is what a diagram
 * actually controls — a number is drawn to fill so much of a stone, and two faces at the
 * same point size can differ by a third in how tall their digits stand.
 */
export function loadTypeface(path: string): LoadedTypeface | null {
  let font: opentype.Font;
  try {
    font = opentype.parse(readFileSync(path).buffer as ArrayBuffer);
  } catch {
    return null;
  }

  const size = 1000;
  const capHeight = measureCapHeight(font, size);
  if (!(capHeight > 0)) return null;

  const cache = new Map<string, RenderGlyph | null>();

  const glyphs: Typeface = (character) => {
    const known = cache.get(character);
    if (known !== undefined) return known;

    const built = buildGlyph(font, character, size, capHeight);
    cache.set(character, built);
    return built;
  };

  return { name: path.split('/').pop() ?? path, glyphs };
}

/** From the top of an H to the baseline, in the units `getPath` draws at. */
function measureCapHeight(font: opentype.Font, size: number): number {
  const box = font.getPath('H', 0, 0, size).getBoundingBox();
  // getPath puts the baseline at y = 0 and everything above it at negative y.
  return -box.y1;
}

function buildGlyph(
  font: opentype.Font,
  character: string,
  size: number,
  capHeight: number,
): RenderGlyph | null {
  const path = font.getPath(character, 0, 0, size);
  if (path.commands.length === 0) return null;

  const contours: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let at: [number, number] = [0, 0];

  // Cap height becomes 1 and the baseline sits at y = 1, so a glyph's box matches the one
  // the stroke font is drawn in and the renderer needs to know which it has.
  const point = (x: number, y: number): [number, number] => [x / capHeight, 1 + y / capHeight];

  const flush = () => {
    if (current.length >= 3) contours.push(current);
    current = [];
  };

  for (const command of path.commands) {
    switch (command.type) {
      case 'M':
        flush();
        at = [command.x, command.y];
        current.push(point(at[0], at[1]));
        break;
      case 'L':
        at = [command.x, command.y];
        current.push(point(at[0], at[1]));
        break;
      case 'Q':
        for (const [x, y] of flattenQuadratic(at, [command.x1, command.y1], [command.x, command.y])) {
          current.push(point(x, y));
        }
        at = [command.x, command.y];
        break;
      case 'C':
        for (const [x, y] of flattenCubic(
          at,
          [command.x1, command.y1],
          [command.x2, command.y2],
          [command.x, command.y],
        )) {
          current.push(point(x, y));
        }
        at = [command.x, command.y];
        break;
      case 'Z':
        flush();
        break;
    }
  }
  flush();

  if (contours.length === 0) return null;

  return { width: font.getAdvanceWidth(character, size) / capHeight, fill: contours };
}

/** Curves become short chords. Sixteen is past the point where more shows up at 30px. */
const STEPS = 16;

function flattenQuadratic(
  from: [number, number],
  control: [number, number],
  to: [number, number],
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    points.push([
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ]);
  }
  return points;
}

function flattenCubic(
  from: [number, number],
  first: [number, number],
  second: [number, number],
  to: [number, number],
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    points.push([
      u * u * u * from[0] + 3 * u * u * t * first[0] + 3 * u * t * t * second[0] + t * t * t * to[0],
      u * u * u * from[1] + 3 * u * u * t * first[1] + 3 * u * t * t * second[1] + t * t * t * to[1],
    ]);
  }
  return points;
}

/**
 * The faces the reader is known to read, from `pnpm faces`.
 *
 * Twenty-one of the fifty-one installed, and the pattern in the other thirty is plain: they
 * are the italics and the obliques, plus most of the monospaces. No book in the corpus
 * prints a slanted numeral, so nothing has taught the reader what one looks like — a real
 * limitation, and one to fix by finding a book that does rather than by inventing one.
 *
 * Generating fixtures in a face the reader is already known to fail would only bank the
 * failure. Re-run `pnpm faces` after teaching it anything new and this list should grow.
 */
export const READABLE = new Set([
  'C059-Bold.otf', 'C059-Roman.otf', 'NimbusRoman-Bold.otf', 'NimbusRoman-Regular.otf',
  'NimbusSans-Bold.otf', 'NimbusSans-Regular.otf', 'NimbusSansNarrow-Regular.otf',
  'P052-Bold.otf', 'P052-Roman.otf', 'URWBookman-Demi.otf', 'URWBookman-Light.otf',
  'URWGothic-Book.otf', 'DejaVuSans.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono.ttf',
  'DejaVuSerif-Bold.ttf', 'DejaVuSerif.ttf', 'LiberationSans-Bold.ttf',
  'LiberationSans-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Regular.ttf',
]);

/**
 * Every face that can draw the characters a diagram needs.
 *
 * Checked rather than assumed: a font that is missing a digit, or whose cap height reads
 * as zero, would silently drop characters out of a fixture and leave its SGF claiming they
 * were there.
 */
export function usableTypefaces(options: { readableOnly?: boolean } = {}): LoadedTypeface[] {
  const wanted = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  return availableFonts()
    .map(loadTypeface)
    .filter((face): face is LoadedTypeface => {
      if (!face) return false;
      if (options.readableOnly && !READABLE.has(face.name)) return false;
      return [...wanted].every((character) => face.glyphs(character) !== null);
    });
}
