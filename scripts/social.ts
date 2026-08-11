/**
 * Draw the card that link previews show:
 *
 *   pnpm social
 *
 * Writes `public/og.png`. Generated rather than drawn by hand so it can be changed by
 * editing this file, and committed rather than built on demand because a crawler fetches it
 * from the deployed site and will not run anything to get it.
 *
 * The mark and the name, and nothing else. A preview has one job — say what the link is —
 * and a strapline under the name does not help it do that; it just gives the eye something
 * to read instead of the thing worth looking at. The mark is the same crosscut as the
 * favicon, at a size where it reads as stones on a board rather than as four dots.
 */
import { drawText, type Rgb } from '../src/render.js';
import { textWidth } from '../src/strokeFont.js';
import { writePng } from '../test/helpers/png.js';
import type { RgbaImage } from '../src/types.js';

// The size every crawler expects, and the aspect they crop to when it is anything else.
const WIDTH = 1200;
const HEIGHT = 630;

const PAPER: Rgb = [251, 250, 247];
const INK: Rgb = [28, 26, 23];
const MUTED: Rgb = [107, 101, 92];
const LINE: Rgb = [176, 168, 156];
const WHITE_STONE: Rgb = [252, 252, 250];

const SPACING = 140;
const RADIUS = 66;
const CENTRE_Y = HEIGHT / 2;

/** How far the grid lines run past the stones. Enough to read as a board, not so far that
 * the mark turns into mostly empty space. */
const REACH = SPACING * 1.15;

const WORDMARK = 'sgfcap';
const SIZE = 150;
const GAP = 84;

// Laid out as one group and then centred, rather than each half being placed by hand: the
// mark and the name belong together, and what should sit in the middle of the card is the
// pair of them.
const markSpan = SPACING + RADIUS * 2;
const wordSpan = textWidth(WORDMARK) * SIZE;
const left = (WIDTH - (markSpan + GAP + wordSpan)) / 2;
const CENTRE_X = left + markSpan / 2;
const WORD_X = left + markSpan + GAP + wordSpan / 2;

const image: RgbaImage = {
  width: WIDTH,
  height: HEIGHT,
  data: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
};

for (let i = 0; i < WIDTH * HEIGHT; i++) {
  image.data.set([...PAPER, 255], i * 4);
}

/** One pixel, blended by how much of it the shape covers, so nothing comes out jagged. */
function blend(x: number, y: number, color: Rgb, coverage: number): void {
  if (coverage <= 0 || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const at = (y * WIDTH + x) * 4;
  const a = Math.min(1, coverage);
  for (let c = 0; c < 3; c++) image.data[at + c] = image.data[at + c] * (1 - a) + color[c] * a;
}

function disc(cx: number, cy: number, radius: number, color: Rgb): void {
  const bound = Math.ceil(radius) + 2;
  for (let y = Math.floor(cy - bound); y <= cy + bound; y++) {
    for (let x = Math.floor(cx - bound); x <= cx + bound; x++) {
      blend(x, y, color, radius + 0.5 - Math.hypot(x - cx, y - cy));
    }
  }
}

function ring(cx: number, cy: number, radius: number, thickness: number, color: Rgb): void {
  const bound = Math.ceil(radius + thickness) + 2;
  for (let y = Math.floor(cy - bound); y <= cy + bound; y++) {
    for (let x = Math.floor(cx - bound); x <= cx + bound; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
      blend(x, y, color, thickness / 2 + 0.5 - d);
    }
  }
}

function bar(x0: number, y0: number, x1: number, y1: number, width: number, color: Rgb): void {
  for (let y = Math.floor(Math.min(y0, y1) - width); y <= Math.max(y0, y1) + width; y++) {
    for (let x = Math.floor(Math.min(x0, x1) - width); x <= Math.max(x0, x1) + width; x++) {
      const along = x0 === x1 ? Math.abs(x - x0) : Math.abs(y - y0);
      const within = x0 === x1 ? y >= y0 && y <= y1 : x >= x0 && x <= x1;
      if (within) blend(x, y, color, width / 2 + 0.5 - along);
    }
  }
}

const spots = [CENTRE_X - SPACING / 2, CENTRE_X + SPACING / 2];
const rows = [CENTRE_Y - SPACING / 2, CENTRE_Y + SPACING / 2];

// Lines first, so the stones sit on them the way they do on a board.
for (const x of spots) bar(x, CENTRE_Y - REACH, x, CENTRE_Y + REACH, 4, LINE);
for (const y of rows) bar(CENTRE_X - REACH, y, CENTRE_X + REACH, y, 4, LINE);

spots.forEach((x, i) => {
  rows.forEach((y, j) => {
    // Black on one diagonal, white on the other: two stones of each colour cutting through
    // each other, which is a crosscut.
    if (i === j) {
      disc(x, y, RADIUS, INK);
    } else {
      disc(x, y, RADIUS, WHITE_STONE);
      ring(x, y, RADIUS, 5, INK);
    }
  });
});

/**
 * Lifted, because `drawText` centres on cap height and "sgfcap" has two descenders.
 * Left on the given centre the word hangs low against the stones — its ink runs from half a
 * cap above the point to eight tenths below, so the middle of what you actually see sits
 * about a seventh of a cap size down. This puts it back.
 */
const DESCENDER_LIFT = SIZE * 0.15;

drawText(image, WORD_X, CENTRE_Y - DESCENDER_LIFT, WORDMARK, {
  size: SIZE,
  weight: 0.13,
  slant: 0,
  color: INK,
});

writePng('public/og.png', image);
console.log(`wrote public/og.png (${WIDTH}x${HEIGHT})`);
