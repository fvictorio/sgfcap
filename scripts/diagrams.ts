/**
 * Drawing random go diagrams.
 *
 * The library half of `pnpm generate`, shared with `pnpm dataset`, which wants the same
 * diagrams for a quite different purpose: one writes them out as fixtures, the other cuts
 * them up into labelled glyphs to train on. Keeping the drawing in one place is what makes
 * those two agree about what a diagram looks like.
 *
 * Every diagram is built so that **no stone is ever captured**: each group is left at least
 * one liberty in the finished position, and since every earlier position is a subset of it,
 * no earlier group can have fewer. That makes the move order free to choose and keeps the
 * printed picture the same as the final board — which is what a book prints, and what the
 * expected SGF has to say.
 */
import { binarize } from '../src/detect/binarize.js';
import { rotateImage } from '../src/detect/deskew.js';
import { renderPosition, type RenderOptions, type Rgb } from '../src/render.js';
import { pointKey, type Mark, type Move, type SgfPosition } from '../src/sgf.js';
import type { MarkShape, Point, RgbaImage, StoneColor } from '../src/types.js';
import type { LoadedTypeface } from './typefaces.js';

const BOARD_SIZE = 19;

/** Deterministic from a seed, so a fixture that catches something can be reproduced. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Chance {
  (): number;
  int(from: number, to: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  float(from: number, to: number): number;
}

function chances(seed: number): Chance {
  const next = random(seed) as Chance;
  next.int = (from, to) => from + Math.floor(next() * (to - from + 1));
  next.pick = (items) => items[Math.floor(next() * items.length)];
  next.chance = (probability) => next() < probability;
  next.float = (from, to) => from + next() * (to - from);
  return next;
}

/**
 * The letters a diagram actually uses.
 *
 * Books letter the points their prose refers to a, b, c, in order, and a diagram that gets
 * past f is a rare one. Drawing from the whole alphabet made fixtures asking the reader for
 * a q or a Z, which no book has ever printed and nothing has taught it.
 */
/**
 * The letters a diagram uses, and that the books have taught.
 *
 * Books letter the points their prose refers to a, b, c, in order, and one that gets past f
 * is rare. Uppercase is rarer still and the corpus has a single A and a single B, so a
 * generated diagram asking for a D would only bank a failure nobody has evidence to fix.
 * Same reasoning as the typeface list: generate what should work, record what does not.
 */
export const BOOK_LETTERS = 'abcdef';
/**
 * Only the triangle, for now.
 *
 * The renderer draws all four of SGF's marks and the reader has an alphabet for all four,
 * but only the triangle has ever appeared in a book, so only the triangle has a prototype.
 * Worse, teaching the other three from generated diagrams was measured and it broke real
 * fixtures: a mark is looked for before a number, and a circle or a square matches a fused
 * two-digit number well enough to swallow it. See the note in `scripts/exemplars.ts`.
 */
export const BOOK_SHAPES: MarkShape[] = ['triangle'];

/** Which part of the board the diagram shows. A crop has to reach a real board edge. */
function pickRegion(next: Chance): NonNullable<RenderOptions['region']> {
  const kind = next.pick(['full', 'corner', 'edge', 'edge'] as const);
  if (kind === 'full') return { left: 0, top: 0, cols: BOARD_SIZE, rows: BOARD_SIZE };

  const span = () => next.int(8, 13);
  const cols = kind === 'corner' ? span() : next.chance(0.5) ? span() : BOARD_SIZE;
  const rows = kind === 'corner' ? span() : cols === BOARD_SIZE ? span() : BOARD_SIZE;

  return {
    left: next.chance(0.5) ? 0 : BOARD_SIZE - cols,
    top: next.chance(0.5) ? 0 : BOARD_SIZE - rows,
    cols,
    rows,
  };
}

/** Liberties of the group at `point`, on a board given as a map. */
function groupLiberties(board: Map<string, StoneColor>, point: Point): number {
  const color = board.get(pointKey(point));
  if (!color) return 0;

  const seen = new Set<string>([pointKey(point)]);
  const liberties = new Set<string>();
  const queue = [point];

  while (queue.length > 0) {
    const at = queue.pop() as Point;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = { x: at.x + dx, y: at.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= BOARD_SIZE || next.y >= BOARD_SIZE) continue;

      const key = pointKey(next);
      const there = board.get(key);
      if (there === undefined) liberties.add(key);
      else if (there === color && !seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }

  return liberties.size;
}

/**
 * Scatter stones inside the region, keeping every group in at least two liberties.
 *
 * Two rather than one, because a stone is placed and then judged: leaving the bare minimum
 * would let the next stone beside it take the last one.
 */
function scatterStones(next: Chance, region: NonNullable<RenderOptions['region']>, count: number) {
  const board = new Map<string, StoneColor>();
  const placed: Array<{ point: Point; color: StoneColor }> = [];

  for (let tries = 0; tries < count * 12 && placed.length < count; tries++) {
    const point = {
      x: region.left + next.int(0, region.cols - 1),
      y: region.top + next.int(0, region.rows - 1),
    };
    if (board.has(pointKey(point))) continue;

    const color: StoneColor = placed.length % 2 === 0 ? 'b' : 'w';
    board.set(pointKey(point), color);

    // Anything this could have put in atari, including the stone itself.
    const touched = [point, ...neighbours(point)].filter((p) => board.has(pointKey(p)));
    if (touched.every((p) => groupLiberties(board, p) >= 2)) {
      placed.push({ point, color });
    } else {
      board.delete(pointKey(point));
    }
  }

  return { board, placed };
}

function neighbours(point: Point): Point[] {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ].filter((p) => p.x >= 0 && p.y >= 0 && p.x < BOARD_SIZE && p.y < BOARD_SIZE);
}

function buildPosition(
  next: Chance,
  region: NonNullable<RenderOptions['region']>,
  options: DiagramOptions = {},
) {
  const letters = options.letters ?? BOOK_LETTERS;
  const shapes = options.shapes ?? BOOK_SHAPES;
  const area = region.cols * region.rows;
  const { board, placed } = scatterStones(next, region, next.int(Math.ceil(area / 14), Math.ceil(area / 6)));

  // Some of the stones are shown as a numbered sequence instead of as setup. Any order is
  // legal here, so they are taken in alternating colour, as a game would go.
  const wantMoves = next.chance(0.65) ? next.int(2, Math.min(12, Math.floor(placed.length / 2))) : 0;
  const byColour = { b: placed.filter((s) => s.color === 'b'), w: placed.filter((s) => s.color === 'w') };
  const moves: Move[] = [];
  // Books number from 1, but a continuation diagram picks up where the last one left off.
  // Kept under three figures: past 99 every number is set small enough to come apart.
  const first = next.chance(0.25) ? next.int(2, 85) : 1;

  let turn: StoneColor = next.chance(0.5) ? 'b' : 'w';
  for (let i = 0; i < wantMoves; i++) {
    const stone = byColour[turn].pop();
    if (!stone) break;
    moves.push({ color: turn, point: stone.point, label: String(first + i) });
    turn = turn === 'b' ? 'w' : 'b';
  }

  const isMove = new Set(moves.map((m) => pointKey(m.point)));
  const setup = placed.filter((s) => !isMove.has(pointKey(s.point)));

  // Letters go on empty points, where a book erases the lines to make room for them.
  const empty: Point[] = [];
  for (let y = region.top; y < region.top + region.rows; y++) {
    for (let x = region.left; x < region.left + region.cols; x++) {
      if (!board.has(pointKey({ x, y }))) empty.push({ x, y });
    }
  }

  // No letters.
  //
  // Not because they cannot be drawn — they can, in any of the faces — but because the
  // corpus has one f, three e and five c to recognise them by, all from two books. In a
  // typeface it has not seen, a is read as c about as often as it is read as a, and a
  // generated diagram full of them banks a dozen failures that say only what is already
  // known. Numbers are a different matter: eighty exemplars of 1 and seventy of 2, from a
  // dozen books, is enough to expect a new face to work.
  const labels = [];
  const most = options.maxLetters ?? 5;
  const wanted = letters === '' ? 0 : next.chance(0.7) ? next.int(1, most) : 0;
  // Books letter a diagram a, b, c in order, so runs are what the reader will meet — but a
  // run always starting at `a` would only ever teach the first few letters of the alphabet.
  // Starting the run anywhere covers all of them and stays a run.
  const runStart = next.int(0, letters.length - 1);
  const used = new Set<string>();
  for (let i = 0; i < wanted && empty.length > 0; i++) {
    const at = empty.splice(next.int(0, empty.length - 1), 1)[0];
    // Books letter a diagram a, b, c… but not always, and never twice the same.
    const text = next.chance(0.6) ? letters[(runStart + i) % letters.length] : next.pick([...letters]);
    if (used.has(text)) continue;
    used.add(text);
    labels.push({ point: at, text });
  }

  // A mark goes on a stone the prose wants to point at, and never on a numbered one.
  const marks: Mark[] = [];
  const markable = setup.filter((s) => !isMove.has(pointKey(s.point)));
  for (let i = 0; i < (next.chance(0.5) ? next.int(1, 3) : 0) && markable.length > 0; i++) {
    const stone = markable.splice(next.int(0, markable.length - 1), 1)[0];
    marks.push({ point: stone.point, shape: next.pick(shapes) });
  }

  const position: SgfPosition = {
    boardSize: BOARD_SIZE,
    black: setup.filter((s) => s.color === 'b').map((s) => s.point),
    white: setup.filter((s) => s.color === 'w').map((s) => s.point),
    labels,
    marks,
    moves,
  };

  return position;
}

/**
 * The floor on cell size, in pixels.
 *
 * A diagram a person cannot read is not a test, it is a complaint. Books reproduce at
 * around this and the real fixtures sit between 17 and 31px, so anything under it is
 * asking the reader to do something no reader should have to.
 */
const MIN_CELL = 25;

/**
 * How large the cell has to be before a number of this many digits can be printed on a
 * stone and still be read — by anyone.
 *
 * A number is scaled to fit inside its stone, so the more digits it has the smaller each
 * one is set. Past a point the strokes stop surviving: at 25px a two-digit number in a
 * serif face put the ring of its 0 down as two thin uprights with the curves too faint to
 * register, and "10" came back as "110". Books have the same constraint and answer it the
 * same way, by printing the diagram larger when the sequence runs long.
 */
function cellFloor(digits: number): number {
  return digits >= 3 ? 36 : digits === 2 ? 30 : MIN_CELL;
}

function pickRenderOptions(
  next: Chance,
  region: NonNullable<RenderOptions['region']>,
  typeface: LoadedTypeface | null,
  digits: number,
): RenderOptions {
  const cellSize = next.int(cellFloor(digits), 40);
  // Books draw stones at 0.45 to 0.48 of the spacing, and the reader leans on that: it
  // tells black from white by the ink in a band from 0.36 to 0.44 out, which a stone drawn
  // any smaller does not reach, and every stone in the diagram then reads as white. Worth
  // knowing as a limit — a book that sets its stones small would defeat it — but not worth
  // drawing here, since no book does.
  const stoneRadius = next.float(0.45, 0.48);

  return {
    cellSize,
    // Tight margins and generous ones both turn up in scans, and the placer cares. Never
    // tighter than the stones themselves, though: a stone on the edge of the board reaches
    // half a cell past the last line, and a crop closer than that slices it in half. Books
    // leave room for their stones, and a stone cut off by the paper is not a hard case, it
    // is a picture of something that was never printed.
    margin: Math.round(cellSize * Math.max(stoneRadius + 0.06, next.float(0.3, 1.1))),
    region,
    ...palette(next),
    lineWidth: cellSize > 26 && next.chance(0.4) ? 2 : 1,
    borderWidth: next.int(1, 4),
    stoneRadius,
    starRadius: next.chance(0.85) ? next.float(0.06, 0.12) : 0,
    textSize: next.float(0.5, 0.62),
    // Only the built-in font is stroked, so weight and slant are its knobs alone; a real
    // face brings its own, and there are bold and italic cuts of most of them.
    textWeight: next.float(0.11, 0.17),
    textSlant: !typeface && next.chance(0.25) ? next.float(0.08, 0.2) : 0,
    markSize: next.float(0.4, 0.56),
    showMoveNumbers: true,
    typeface: typeface?.glyphs,
  };
}

/**
 * The colours a diagram is drawn in.
 *
 * Books print black on white and that is what this drew, always, from one hardcoded
 * `[255, 255, 255]`. It is worth spelling out what that costs, because it cost us: a model
 * trained on a hundred thousand of these has seen white paper a hundred thousand times and
 * has no way to know that the paper was ever a variable. The first board that arrived on
 * wood — `2026-08-19_12-37`, a screenshot from a playing program — had every one of its
 * white stones read as an empty point, and there is no threshold that recovers them,
 * because on wood a white stone is not made of ink at all.
 *
 * So the board is a variable now, and with it the two things that move when it does. A
 * white stone on white paper needs a rim or it is invisible, and books duly print one as
 * dark as the grid; a white stone on wood is already visible and often gets barely any. A
 * generator that always draws the crisp rim teaches that white stones have crisp rims,
 * which is the same mistake one level down.
 *
 * Weighted towards paper, because most diagrams are still printed, but not overwhelmingly:
 * what is being bought here is that neither case is a surprise.
 */
function palette(next: Chance): Pick<RenderOptions, 'paper' | 'ink' | 'stoneLight' | 'stoneEdge'> {
  const ink: Rgb = [next.int(0, 45), next.int(0, 45), next.int(0, 45)];

  // Paper, off-white and the greys a screenshot comes back as.
  if (next.chance(0.6)) {
    const shade = next.int(236, 255);
    return {
      paper: [shade, shade, next.int(Math.min(shade, 232), shade)],
      ink,
      stoneLight: [next.int(245, 255), next.int(245, 255), next.int(242, 255)],
      stoneEdge: ink,
    };
  }

  // Wood, from pale maple to the orange of a cheap render, and the tinted greys of a screen.
  const wood = next.chance(0.8);
  const base = wood ? next.int(170, 235) : next.int(150, 215);
  const paper: Rgb = wood
    ? [base, Math.round(base * next.float(0.78, 0.93)), Math.round(base * next.float(0.5, 0.75))]
    : [base, base, Math.round(base * next.float(0.96, 1.0))];

  // On a board this dark a white stone reads on its own, so the rim runs from a full ink
  // line down to something barely there.
  const rim = next.float(0, 1);
  const stoneEdge: Rgb = [
    Math.round(ink[0] * rim + paper[0] * (1 - rim) * 0.85),
    Math.round(ink[1] * rim + paper[1] * (1 - rim) * 0.85),
    Math.round(ink[2] * rim + paper[2] * (1 - rim) * 0.85),
  ];

  return {
    paper,
    ink,
    stoneLight: [next.int(228, 255), next.int(226, 253), next.int(220, 250)],
    stoneEdge,
  };
}

/**
 * Sample the finished diagram down, the way a book scanned at a lower resolution is.
 *
 * Drawing small and being made small are not the same picture, and only the second one turns
 * up in the wild. The renderer draws a crisp one-pixel stroke at whatever size it is asked
 * for, so a diagram drawn at an eighteen pixel cell is a *tidy* small diagram; a diagram drawn
 * at thirty and then sampled down to eighteen has had its strokes blurred, merged and partly
 * eaten, which is what actually happens between a printed page and a low resolution scan.
 *
 * It matters because the floor on cell size is real and cannot simply be lowered. Two digit
 * numbers are not drawn below a thirty pixel cell and three digit ones not below thirty six,
 * because below that the renderer cannot lay out digits that a person could read, and a
 * training set of illegible glyphs teaches nothing but noise. Sampling down afterwards has no
 * such problem: the number is laid out legibly and then made small, and it stays labelled
 * correctly however small it gets.
 *
 * The gap this fills was exact. `sh-big` and `sh-smaller` are the same diagram at two
 * resolutions; the first reads perfectly and the second does not, and its digits are ten
 * pixels tall against a training set whose fifth percentile is thirteen. Every glyph the
 * reader had ever seen was bigger than the ones it was failing on.
 */
/**
 * How often a diagram is sampled down.
 *
 * A minority of the set, deliberately: small diagrams are the tail of what arrives, and a
 * training set that makes them a third of everything spends capacity the common case wants.
 * Against a control trained the same way without it, one diagram in six is worth about a
 * point of glyph accuracy on books the model has never seen; two in five gained less.
 *
 * It does what it was drawn for and does not yet pay for itself. `sh-smaller` — the same
 * diagram as `sh-big` at a lower resolution, whose digits are ten pixels against a training
 * set whose fifth percentile is thirteen — climbs from 0.84 to between 0.87 and 0.94
 * depending on the run. But every model that improves it reads some other diagram worse, and
 * across four seeds none came out ahead of the weights already shipped. The likeliest reason
 * is simply too little of everything: the small case is being learned at the expense of the
 * common one rather than alongside it, which is an argument for a larger drawn set rather
 * than a different mixture.
 *
 * Two measurements worth keeping, because both were assumed wrong before they were made.
 * Four training runs differing only in their seed spread two fixtures, not five. And glyph
 * accuracy on held-back books runs *opposite* to whole-diagram correctness across those runs
 * — the seed with the best glyphs read the fewest diagrams right — because one misread digit
 * cascades through the move sequence and costs a whole diagram, so the two measure different
 * things and neither settles the other.
 */
const SAMPLED_DOWN = 0.18;

function shrink(
  next: Chance,
  worn: { image: RgbaImage; notes: string[] },
  cellSize: number,
  digits: number,
): { image: RgbaImage; notes: string[] } {
  // How small a cell may become, by how much has to fit inside it. A number needs room even
  // after the sampling, and a diagram nobody could read is not a hard case, it is a ruined one.
  //
  // Set from what books actually print rather than from what looks comfortable. The corpus
  // has a diagram numbering its moves past a hundred on a 19px spacing — three digits in the
  // width of a stone, each one about five pixels across — and drawn diagrams stopped at a
  // 36px cell for three digits, so nothing in the training set was within twice that size.
  const floor = digits >= 3 ? 18 : digits === 2 ? 15 : 11;

  if (!next.chance(SAMPLED_DOWN) || cellSize <= floor) return worn;

  const target = next.int(floor, cellSize - 1);
  const factor = target / cellSize;

  return {
    image: downscale(worn.image, factor),
    notes: [...worn.notes, `sampled down to a ${target}px cell`],
  };
}

/**
 * Scale an image down, averaging over the pixels each output pixel covers.
 *
 * Averaged rather than sampled, which is the difference between a scan and an artefact. Taking
 * the nearest source pixel — what `resample` does, and all it needs to do, since it goes back
 * up again immediately — drops whole strokes at these factors instead of thinning them, and
 * teaches a reader that a 4 is sometimes missing its stem.
 */
function downscale(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));

    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < image.height; sy++) {
        for (let sx = x0; sx < x1 && sx < image.width; sx++) {
          const from = (sy * image.width + sx) * 4;
          r += image.data[from];
          g += image.data[from + 1];
          b += image.data[from + 2];
          a += image.data[from + 3];
          n++;
        }
      }

      const at = (y * width + x) * 4;
      data[at] = r / n;
      data[at + 1] = g / n;
      data[at + 2] = b / n;
      data[at + 3] = a / n;
    }
  }

  return { width, height, data };
}

/**
 * Wear the picture down the way a scan or a screenshot does — but only so far.
 *
 * At most two treatments, from a list where each on its own leaves a diagram a person can
 * still read. Stacking was the mistake first time round: a tilt and a resample and a blur
 * and noise, all on an 18px cell, produced pictures nobody could have read, which test
 * nothing except how the reader fails. Everything softening the image also needs room to
 * soften, so the fuzzier treatments ask for a larger cell.
 */
function degrade(next: Chance, image: RgbaImage, cellSize: number): { image: RgbaImage; notes: string[] } {
  const treatments: Array<{ name: string; apply: (image: RgbaImage) => RgbaImage }> = [
    {
      name: 'tilt',
      apply: (input) => {
        const angle = next.float(-1.5, 1.5);
        notes[notes.length - 1] = `tilt ${angle.toFixed(2)}°`;
        return rotateImage(input, angle);
      },
    },
    {
      name: 'levels',
      apply: (input) => {
        // Never below a range of 150, which is where a scan stops being a scan.
        const low = next.int(0, 55);
        const high = next.int(Math.max(205, low + 150), 255);
        notes[notes.length - 1] = `levels ${low}-${high}`;
        return levels(input, low, high);
      },
    },
    {
      name: 'noise',
      apply: (input) => {
        const amount = next.float(4, 13);
        notes[notes.length - 1] = `noise ±${amount.toFixed(0)}`;
        return noise(next, input, amount);
      },
    },
    ...(cellSize >= 26
      ? [
          {
            name: 'resample',
            apply: (input: RgbaImage) => {
              const factor = next.float(0.72, 0.9);
              notes[notes.length - 1] = `resampled at ${factor.toFixed(2)}`;
              return resample(resample(input, factor), 1 / factor);
            },
          },
          {
            name: 'blur',
            apply: (input: RgbaImage) => {
              notes[notes.length - 1] = 'blur 1';
              return blur(input, 1);
            },
          },
        ]
      : []),
  ];

  const notes: string[] = [];
  const budget = next.chance(0.25) ? 0 : next.chance(0.6) ? 1 : 2;
  let out = image;

  const remaining = [...treatments];
  for (let i = 0; i < budget && remaining.length > 0; i++) {
    const [chosen] = remaining.splice(next.int(0, remaining.length - 1), 1);
    notes.push(chosen.name);
    out = chosen.apply(out);
  }

  return { image: out, notes };
}

function resample(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / factor));
      const sy = Math.min(image.height - 1, Math.floor(y / factor));
      const from = (sy * image.width + sx) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }

  return { width, height, data };
}

function blur(image: RgbaImage, radius: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data.length);

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      let total = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
          total += image.data[(ny * image.width + nx) * 4];
          count++;
        }
      }
      const at = (y * image.width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = total / count;
      data[at + 3] = 255;
    }
  }

  return { width: image.width, height: image.height, data };
}

/** Squeeze the tonal range, as a photocopy or a grey scan does. */
function levels(image: RgbaImage, low: number, high: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const value = low + (data[i] / 255) * (high - low);
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  return { width: image.width, height: image.height, data };
}

function noise(next: Chance, image: RgbaImage, amount: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const shift = (next() - 0.5) * 2 * amount;
    data[i] += shift;
    data[i + 1] += shift;
    data[i + 2] += shift;
  }
  return { width: image.width, height: image.height, data };
}

export interface DiagramOptions {
  /** Which letters may appear on bare points. */
  letters?: string;
  /** Which marks may be drawn on stones. */
  shapes?: MarkShape[];
  /**
   * How many letters a diagram may carry. A book prints a handful; a diagram drawn to train
   * on wants as many as will fit, since every one is another labelled sample.
   */
  maxLetters?: number;
}

export interface Diagram {
  name: string;
  notes: string[];
  image: RgbaImage;
  position: SgfPosition;
  /** The face it was set in, or null for the built-in stroke font. */
  typeface: LoadedTypeface | null;
}

export function makeDiagram(
  seed: number,
  faces: LoadedTypeface[],
  options: DiagramOptions = {},
): Diagram {
  const next = chances(seed);
  const region = pickRegion(next);
  const position = buildPosition(next, region, options);
  // A tenth of the time the built-in stroke font, which is the only one that exists when
  // no fonts are installed and so has to keep working.
  const typeface = faces.length > 0 && next.chance(0.9) ? next.pick(faces) : null;
  const digits = Math.max(1, ...position.moves.map((move) => (move.label ?? '').length));
  const drawing = pickRenderOptions(next, region, typeface, digits);
  const worn = degrade(next, renderPosition(position, drawing), drawing.cellSize ?? 28);
  const { image, notes } = shrink(next, worn, drawing.cellSize ?? 28, digits);

  const name = `gen-${String(seed).padStart(6, '0')}`;
  const threshold = binarize(image).threshold;

  return {
    name,
    image,
    position,
    typeface,
    notes: [
      `${region.cols}x${region.rows} at ${region.left},${region.top}`,
      `${position.black.length + position.white.length} stones`,
      `${position.moves.length} moves`,
      `${position.labels.length} letters`,
      `${position.marks.length} marks`,
      `cell ${drawing.cellSize}px`,
      `${digits}-digit`,
      typeface?.name ?? 'built-in font',
      `threshold ${threshold}`,
      ...notes,
    ],
  };
}
