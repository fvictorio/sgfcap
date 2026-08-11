import { binarize, localizeStones, type BinaryImage } from './detect/binarize.js';
import { classify, rank } from './detect/classify.js';
import { deskewImage } from './detect/deskew.js';
import { upscale } from './detect/resample.js';
import { maskSurround } from './detect/trim.js';
import {
  readPointLabel,
  readStoneLabel,
  readStoneMark,
  readPointLetters,
  readStoneNumbers,
  stoneIsInked,
  type Glyph,
  type Reader,
} from './detect/digits.js';
import { carriesPrintAll, imageLevels, type At } from './detect/gate.js';
import { detectGrid, type Grid } from './detect/grid.js';
import { classifyIntersection } from './detect/stones.js';
import { resolve, type Lettered } from './detect/letters.js';
import { readStones } from './detect/stoneNet.js';
import { reconcile, type Numbered } from './detect/sequence.js';
import { serializeSgf, type Move, type SgfPosition } from './sgf.js';
import { SgfCaptureError, type BoardAnalysis, type Intersection, type Point, type RgbaImage } from './types.js';

/**
 * How much of the grid lines may still show through an empty point that carries a letter.
 *
 * A reference letter is printed in place of the lines, which are erased around it, so an
 * empty point whose lines are intact cannot be carrying one.
 *
 * This gate is load-bearing and worth respecting. Offered every empty point, the letter
 * reader accepts 435 of them across the fixtures — board edges especially, where the
 * border's L and T shapes read as b, c, d or f, and the star points, whose dot and stubs
 * of line read as f. What keeps those out is only this: measured across every fixture,
 * real letters sit at 0.25 and below, and the lowest-scoring false positive at 0.375.
 *
 * That margin only holds because the arm measure counts out of four lines wherever it is
 * taken; dividing by the lines a point actually has put a letter on the board's edge at
 * 0.33 and lost it. See `armInk`.
 */
const MAX_LINE_INK_UNDER_LABEL = 0.32;

/**
 * How much grid line may show through a point before the gate is not even asked about it.
 *
 * Purely to save work, and set where it costs nothing. The gate is a convolutional net and
 * running it over every point of a board is most of the time spent reading a diagram — but
 * of nineteen thousand bare points across the corpus, only the handful with their lines
 * interrupted could be carrying anything, and the rest are plainly untouched crossings that
 * it dutifully and expensively agrees are untouched.
 *
 * So the cheap measure proposes and the net disposes. It is deliberately far looser than the
 * threshold it sits in front of, because its only job is to avoid throwing away a letter
 * before the net has looked: the most intact-looking real letter in the corpus reads 0.35,
 * and this is set at twice that. Everything from there down still goes to the net, which is
 * what decides. At this setting the net sees five points in a hundred and reads every letter
 * it read before.
 */
const GATE_PREFILTER = 0.7;


/**
 * Read a go diagram and return it as SGF.
 *
 * The whole pipeline runs in the browser: pass decoded pixels in, get SGF text out.
 * Use `analyzeImage` instead when you need to see how the reading was arrived at.
 */
export interface ReadOptions {
  /**
   * How to score every character a glyph might be, rather than only the best one.
   *
   * Left out, the trained classifier does it. The move sequence uses these to choose between
   * readings that a single stone cannot choose between on its own.
   */
  ranker?: (glyph: Glyph, kind: 'digit' | 'letter' | 'mark') => Array<{ label: string; score: number }>;
  /**
   * How to read the characters printed on the diagram.
   *
   * Left out, the trained classifier does it. Supplying one swaps in something else, which is
   * how a different model is tried without disturbing what already works.
   */
  reader?: Reader;
}

export async function imageToSgf(image: RgbaImage, options: ReadOptions = {}): Promise<string> {
  const analysis = await analyzeImage(image, options);
  return serializeSgf(toPosition(analysis));
}

/**
 * Read a diagram and return the detector's full working: the grid it found, where it
 * decided the crop sits on the board, and its per-intersection calls with confidence.
 *
 * Straighten, binarize, find the grid, work out which part of the board it is, and
 * classify every intersection. A diagram cropped to a corner or an edge is placed by
 * which board edges are in view; one showing neither is rejected rather than guessed at.
 */
/**
 * The grid spacing, in pixels, that the reader is comfortable at.
 *
 * Deliberately low. Enlarging is not free — it moves every stroke onto new pixels, and a
 * diagram that was already readable can come back different, which is what happens to four
 * fixtures at 24 to 26 pixels a point if they are enlarged for no reason. So this is set to
 * the least that still rescues the diagrams that need it, not to where reading is easiest.
 *
 * `sh-big` and `sh-smaller` are the same diagram at 30.9 and 17.9 pixels a point, which is as
 * close to a controlled experiment as a corpus of books gets: as printed the small one loses
 * ten move numbers, and doubled it reads perfectly.
 */
const COMFORTABLE = 20;

/**
 * Past this the image is not small, it is blank — a photograph of a wall will produce some
 * grid at some spacing, and enlarging it forty times to find that out is a way to hang a
 * browser tab rather than a way to read a diagram.
 */
const MAX_ENLARGEMENT = 4;

/**
 * Below this the ink tests have not decided a stone's colour, they have landed on the cutoff.
 * Their confidence is the distance from it, so this is small on purpose: it is meant to catch
 * the coin-flips, not to second-guess a call the rules actually made.
 */
const UNDECIDED = 0.1;

export async function analyzeImage(
  image: RgbaImage,
  options: ReadOptions = {},
): Promise<BoardAnalysis> {
  assertUsableImage(image);

  const ready = prepare(image);
  if (ready.factor === 1 && ready.left === 0 && ready.top === 0) {
    return analyzeAsGiven(ready.image, options);
  }

  const analysis = await analyzeAsGiven(ready.image, options);
  // The caller's overlay is drawn over the image the caller passed in, so put the grid back
  // in its coordinates. Everything else an analysis carries is in board coordinates already.
  return {
    ...analysis,
    grid: {
      xs: analysis.grid.xs.map((x) => x / ready.factor + ready.left),
      ys: analysis.grid.ys.map((y) => y / ready.factor + ready.top),
    },
  };
}

/** The picture the reader will work from, and where it sits in the one handed in. */
interface Prepared {
  image: RgbaImage;
  left: number;
  top: number;
  factor: number;
}

/**
 * Get the picture into the state the reader expects: a diagram, big enough to read.
 *
 * Two things can be wrong with what arrives, and they have to be settled in this order. A
 * photograph may have caught the desk around the page, which has to go before anything is
 * measured — see `maskSurround`. Only then does the grid spacing mean anything, and only
 * then is it worth asking whether the diagram wants enlarging.
 */
function prepare(image: RgbaImage): Prepared {
  const painted = maskSurround(image);

  // Whether to trim is settled by which version yields more of a board, not by how much
  // there was to cut. The same test `findGrid` already uses to choose between its two
  // thresholds, and for the same reason: what a surround is cannot be told from the pixels
  // as reliably as it can be told from what taking it away does. `screenshot-editor` has a
  // dark panel around its board that looks worth painting out, and painting it out loses the
  // board altogether.
  const asGiven = survey(image);
  const asPainted = painted ? survey(painted.image) : null;
  const take = painted !== null && asPainted !== null && asPainted.lines > asGiven.lines;

  const chosen = take ? painted! : { image, left: 0, top: 0 };
  const spacing = (take ? asPainted!.spacing : asGiven.spacing) ?? null;

  const factor =
    spacing === null || spacing >= COMFORTABLE
      ? 1
      : Math.min(MAX_ENLARGEMENT, Math.ceil(COMFORTABLE / spacing));

  return {
    image: factor === 1 ? chosen.image : upscale(chosen.image, factor),
    left: chosen.left,
    top: chosen.top,
    factor,
  };
}

/** What a board looks like in this picture, if one can be found at all. */
function survey(image: RgbaImage): { lines: number; spacing: number | null } {
  try {
    const grid = findGrid(deskewImage(image, binarize(image)).image);
    return { lines: grid.xs.length + grid.ys.length, spacing: grid.spacing };
  } catch {
    return { lines: 0, spacing: null };
  }
}

async function analyzeAsGiven(
  image: RgbaImage,
  options: ReadOptions = {},
): Promise<BoardAnalysis> {
  // The trained classifier unless the caller brings its own. It is the only reader now: the
  // prototype matcher it replaced learned its shapes from the fixtures themselves, so a
  // character no fixture happened to contain was one it could not read — capital letters and
  // a square mark among them — and it was finally behind on the corpus as well as in
  // principle.
  const read: Reader = options.reader ?? ((glyph, kind) => classify(glyph, kind)?.label ?? null);
  const score = options.ranker ?? ((glyph, kind) => rank(glyph, kind));

  // Straighten first: everything below assumes the board is square to the image.
  const upright = deskewImage(image, binarize(image));
  const mask = binarize(upright.image);
  const structure = binarize(upright.image, 'structure');
  const levels = imageLevels(upright.image, mask);
  const grid = findGrid(upright.image);
  const size = grid.boardSize;

  const { region } = grid;
  const intersections: Intersection[] = [];

  /**
   * What is standing on each point, worked out for the whole board before anything is read.
   *
   * Two passes rather than one because the gate is a net, and a net would rather be asked
   * about sixty points at once than about one point sixty times — it is most of the work of
   * reading a diagram, and batching it is worth about three times the speed. Nothing else
   * changes: the first pass decides what is a stone, the second reads what is printed.
   */
  const placed: Array<{
    point: { x: number; y: number };
    col: number;
    row: number;
    color: ReturnType<typeof classifyIntersection>['color'];
    confidence: number;
    lineInk: number | null;
    faint: boolean;
  }> = [];

  // Only the part of the board the diagram actually shows. `region` says where that sits,
  // so the points come out in full-board coordinates either way.
  for (let row = 0; row < region.rows; row++) {
    for (let col = 0; col < region.cols; col++) {
      const point = { x: region.left + col, y: region.top + row };
      const { color, confidence, lineInk, faint } = classifyIntersection(
        mask,
        grid.xs[col],
        grid.ys[row],
        grid.spacing,
        {
          // Whether a line runs on, judged on the real board: a line cut off by the crop
          // still continues past the point.
          left: point.x > 0,
          right: point.x < size - 1,
          up: point.y > 0,
          down: point.y < size - 1,
        },
        structure,
      );

      placed.push({ point, col, row, color, confidence, lineInk, faint });
    }
  }

  // A stone the ink tests give up on may still be there. The model is asked only about the
  // points they called empty, and only ever allowed to add — measured on sources held out of
  // its training it misses fourteen stones and invents none, and gets no colour wrong, so
  // adding is the one direction in which it is strictly better than nothing. Overruling the
  // rules with it would be worse than the rules.
  //
  // This is what reads a board drawn on wood. There a white stone is a pale disc on a pale
  // board with no ink anywhere, and every threshold in `stones.ts` is calibrated on ink.
  // Faint stones are asked about as well, because they are the ones in doubt: the model is
  // the only thing here that can say "no stone" about a point whose lines have vanished.
  //
  // Points the ink tests did answer, but at the boundary, are asked as well. Colour there is
  // `body >= BLACK_BODY` and nothing else, so a confidence near zero does not mean a close
  // call between two readings — it means `body` landed on the cutoff and the answer is which
  // side of it the rounding fell. `compressed` has a white stone whose body sits exactly
  // there, and it reads white or black depending on how the image was scaled on the way in.
  // Taking the model there is not overruling the rules; there is no opinion to overrule.
  const blank = placed.filter((p) => p.color === null || p.faint || p.confidence < UNDECIDED);
  const found = readStones(
    upright.image,
    levels,
    blank.map((p): At => ({ cx: grid.xs[p.col], cy: grid.ys[p.row] })),
    grid.spacing,
  );
  const modelSays = new Map<(typeof placed)[number], 'b' | 'w' | 'empty' | 'unsure'>();
  if (found) {
    blank.forEach((p, i) => {
      modelSays.set(p, found[i]);
      const says = found[i];
      // Adding a stone the rules missed, or naming the colour of one they could not call.
      // Never removing: `empty` from the model against a stone the rules are sure of is the
      // one direction it was measured to be worse than them.
      if ((says === 'b' || says === 'w') && (p.color === null || p.confidence < UNDECIDED)) {
        p.color = says;
        p.confidence = 0.5;
      }
    });
  }

  // Black stones get their insides re-thresholded against themselves before anything is read
  // off them, because a page-wide cutoff cannot also separate a white number from the black
  // stone it is printed on — see `localizeStones`.
  const stoneMask = localizeStones(
    upright.image,
    mask,
    placed.filter((p) => p.color === 'b').map((p) => ({ cx: grid.xs[p.col], cy: grid.ys[p.row] })),
    grid.spacing * 0.42,
  );

  // Every bare point the gate has to judge, asked in one go — see `gate.ts`. Points whose
  // lines run straight through are not worth asking about; see `GATE_PREFILTER`.
  // Stones held on the faintest evidence are asked about too. The only thing that made them
  // stones is that the lines beneath them had gone, and a letter printed over those lines
  // does exactly the same — `2026-08-14_10-46` letters two points E and F and both come back
  // as white stones. The gate is the thing that can tell printing from a rim, so it is given
  // the casting vote.
  const bare = placed.filter(
    (p) => (p.color === null || p.faint) && p.lineInk !== null && p.lineInk < GATE_PREFILTER,
  );
  const verdicts = carriesPrintAll(
    upright.image,
    levels,
    bare.map((p): At => ({ cx: grid.xs[p.col], cy: grid.ys[p.row] })),
    grid.spacing,
  );
  const gated = new Map<(typeof placed)[number], boolean>();
  bare.forEach((p, i) => gated.set(p, verdicts?.[i] ?? false));

  // A faint stone the gate calls printing is a letter, and goes back to being an empty point
  // so that the letter can be read off it — but only with the model's agreement.
  //
  // The gate alone is not enough, and the reason is worth stating: it was trained on bare
  // points and has never been shown a stone, so a white stone with a number printed on it is
  // outside everything it knows and it duly reports printing. Asked the same question the
  // model answers from a training set that contains both, and it invents no stones at all on
  // sources held out of it. Both have to agree before a stone is given up.
  for (const p of placed) {
    const backed = modelSays.get(p) === 'b' || modelSays.get(p) === 'w';
    if (p.faint && p.color !== null && gated.get(p) && !backed) {
      p.color = null;
      p.faint = false;
    }
  }

  for (const at of placed) {
    {
      const { point, col, row, color, confidence, lineInk } = at;
      // A stone carries a number or a shape, never both, and the shape is asked about
      // first. A triangle is wider than it is tall, which is exactly what the number
      // reader takes as a sign to cut a glyph into digits — left to go first it chops a
      // triangle into "221" and the mark is never looked for.
      const mark = color
        ? readStoneMark(
            color === 'b' ? stoneMask : mask,
            grid.xs[col],
            grid.ys[row],
            grid.spacing,
            color,
            read,
          )
        : null;

      // Whether to ask the reader about a bare point at all. The reader is only ever asked
      // *which* character this is, so a point offered to it with nothing on it comes back
      // with a letter regardless — see `gate.ts`. Where no gate has been trained this falls
      // back to the threshold that stood here before, which reads the same intent off a
      // single number: a letter is printed in place of the lines, so an untouched crossing
      // cannot be carrying one.
      const printed =
        color !== null
          ? false
          : verdicts !== null
            ? gated.get(placed.find((p) => p.point === point)!)!
            : lineInk !== null && lineInk < MAX_LINE_INK_UNDER_LABEL;

      const label =
        mark !== null
          ? null
          : color
            ? readStoneLabel(
                color === 'b' ? stoneMask : mask,
                grid.xs[col],
                grid.ys[row],
                grid.spacing,
                color,
                read,
              )
            : printed
              ? readPointLabel(
                  mask,
                  grid.xs[col],
                  grid.ys[row],
                  grid.spacing,
                  read,
                )
              : null;

      intersections.push({
        point,
        color,
        confidence,
        ...(color === null
          ? {}
          : {
              // A stone showing a shape is inked but is not a move, and counting it as one
              // would stretch the run by a number that was never printed.
              inked:
                mark === null &&
                stoneIsInked(
                  color === 'b' ? stoneMask : mask,
                  grid.xs[col],
                  grid.ys[row],
                  grid.spacing,
                  color,
                ),
              options: readStoneNumbers(
                color === 'b' ? stoneMask : mask,
                grid.xs[col],
                grid.ys[row],
                grid.spacing,
                color,
                (glyph) => score(glyph, 'digit'),
              ),
            }),
        ...(label === null ? {} : { label }),
        ...(mark === null ? {} : { mark }),
        ...(color === null && printed
          ? {
              options: readPointLetters(
                mask,
                grid.xs[col],
                grid.ys[row],
                grid.spacing,
                (glyph) => score(glyph, 'letter'),
              ),
            }
          : {}),
      });
    }
  }

  return {
    boardSize: size,
    region,
    intersections,
    grid: { xs: grid.xs, ys: grid.ys },
  };
}

/**
 * Find the grid, trying both ways of separating the picture from its paper.
 *
 * A printed diagram is often three things — paper, the ink of the stones, and a grid drawn
 * grey between them — and one threshold has to put the grey on one side or the other. Grey
 * with the paper loses the grid entirely, which is what happens to `2026-08-13_17-22`: its
 * lines sit at 164 against a cutoff of 141 and the mask keeps only the crossings. Grey with
 * the ink is worse in the other direction, since a mask where grey counts as ink would make
 * every white stone black.
 *
 * Which is wanted cannot be told from the histogram. The grey band in `opening-01` looks
 * just like the one in `2026-08-13_17-22` and is not a grid at all — it is the antialiasing
 * around the stones, and taking it thickens everything until no board can be found. What
 * separates them is not how they are distributed but what they yield, so both are tried and
 * the one that finds more of a board wins. The ink mask breaks the tie, being the one every
 * other stage reads from.
 */
export function findGrid(image: RgbaImage, expected?: number): Grid {
  const attempts: Grid[] = [];
  let failure: unknown;

  for (const level of ['ink', 'structure'] as const) {
    try {
      attempts.push(detectGrid(binarize(image, level), expected));
    } catch (cause) {
      failure ??= cause;
    }
  }

  if (attempts.length === 0) throw failure;

  // A reading whose edges account for what it found beats one that had to be reconciled,
  // however many lines the second turned up. `2026-08-13_17-22` is read both ways: one
  // threshold places it against the board's left edge and adds up, the other finds the same
  // number of lines and has to guess which of two edges to believe, and guesses wrong.
  return attempts.reduce((best, grid) => {
    if (grid.sure !== best.sure) return grid.sure ? grid : best;
    return grid.xs.length + grid.ys.length > best.xs.length + best.ys.length ? grid : best;
  });
}

/**
 * Collapse an analysis down to a diagram: numbered stones become the move sequence, in
 * number order, and everything else is setup.
 *
 * A stone the sequence captures stays in the setup — the diagram prints it, and replaying
 * the moves is what lifts it back off.
 */
export function toPosition(analysis: BoardAnalysis): SgfPosition {
  const position: SgfPosition = {
    boardSize: analysis.boardSize,
    black: [],
    white: [],
    labels: [],
    marks: [],
    moves: [],
  };

  // Every stone, with whatever number was read on it — including none, since a stone whose
  // number went unread may still be a move and the sequence may be able to say which.
  const stones: Array<Numbered<{ point: Point; color: 'b' | 'w' }>> = [];
  const lettered: Array<Lettered<Point>> = [];

  for (const { color, point, label, mark, inked, options: choices } of analysis.intersections) {
    if (mark !== undefined) position.marks.push({ point, shape: mark });

    if (!color) {
      // A letter on a bare point marks it for the prose to refer to; it is not a move.
      //
      // A point the gate says carries printing counts as one even where the reader could not
      // name the character — `options` is only gathered where the gate opened, so its presence
      // is that verdict. The run can often say what the glyph could not: `2026-08-14_10-46`
      // letters six points A to F and the reader declines on the F, which under the old rule
      // dropped the point entirely and left the other five to be read as a run of five.
      if (label !== undefined || (choices !== undefined && choices.length > 0)) {
        lettered.push({ point, options: choices ?? [], read: label });
      }
      continue;
    }

    const order = label === undefined ? Number.NaN : Number.parseInt(label, 10);
    stones.push({
      stone: { point, color },
      color,
      order: Number.isFinite(order) ? order : null,
      inked: inked ?? false,
      options: (choices ?? []).map((o) => ({ order: Number.parseInt(o.text, 10), score: o.score })),
    });
  }

  // The letters have to agree with each other too — see `letters.ts`. A diagram letters its
  // points in a run and never twice the same, which settles readings no single point can.
  const chosen = resolve(lettered);
  lettered.forEach((entry, i) => {
    const text = chosen?.[i] ?? entry.read;
    if (text !== undefined) position.labels.push({ point: entry.point, text });
  });

  // The sequence has the last word on the numbers — see `reconcile`. One stone at a time
  // cannot tell a misread 8 from a real one; the run it belongs to can.
  const orders = reconcile(stones);

  const numbered: Array<{ order: number; move: Move }> = [];
  stones.forEach((entry, i) => {
    const order = orders[i];
    const { point, color } = entry.stone;
    if (order === null) {
      // Unnumbered, or carrying something that is not a move number.
      (color === 'b' ? position.black : position.white).push(point);
      return;
    }
    // The printed number is carried through rather than replaced by the move's index, so a
    // diagram numbered 11-20 still reads 11-20 on the board.
    numbered.push({ order, move: { color, point, label: String(order) } });
  });

  numbered.sort((a, b) => a.order - b.order);
  position.moves = numbered.map((entry) => entry.move);

  return position;
}

function assertUsableImage(image: RgbaImage): void {
  if (image.width <= 0 || image.height <= 0) {
    throw new SgfCaptureError(`Image has no pixels (${image.width}x${image.height}).`);
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new SgfCaptureError(
      `Expected ${image.width * image.height * 4} bytes of RGBA for a ` +
        `${image.width}x${image.height} image, got ${image.data.length}.`,
    );
  }
}
