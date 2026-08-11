import { SgfCaptureError, type BoardRegion } from '../types.js';
import { isDark, type BinaryImage } from './binarize.js';

/**
 * The sizes a go board comes in, largest first.
 *
 * A diagram showing both edges of an axis says its own size — the lines between them are the
 * board. Only these counts are believed: a reading of fifteen lines with both edges in view
 * is a misread edge, not a fifteen by fifteen board, and saying so is better than inventing
 * a board that does not exist.
 */
export const BOARD_SIZES = [19, 13, 9] as const;

export interface Grid {
  /** Pixel x of each vertical line, left to right. */
  readonly xs: number[];
  /** Pixel y of each horizontal line, top to bottom. */
  readonly ys: number[];
  /** Mean distance between adjacent lines. */
  readonly spacing: number;
  /** Where the lines found sit on the full board. */
  readonly region: BoardRegion;
  /** How big the board turned out to be. */
  readonly boardSize: number;
  /**
   * Whether the edges of the board account for what was found, or had to be talked round.
   *
   * False where the line counts and the edge tests contradicted each other and the placement
   * is the better of two readings rather than the only one. Worth carrying because the same
   * picture thresholded two ways gives two grids, and one that adds up should be taken over
   * one that had to be reconciled even when the second finds a line or two more.
   */
  readonly sure: boolean;
}

/** Which ends of an axis show the board's own edge rather than a cut. */
interface Ends {
  start: boolean;
  end: boolean;
  /** How far the picture stays clear beyond each end, in spacings — see `blankReach`. */
  startReach: number;
  endReach: number;
}

/** A line has to reach this share of a typical line's projection peak to count. */
const PEAK_RATIO = 0.5;

/** Below this many lines there is nothing to take a typical height from. */
const MIN_PEAKS_FOR_TYPICAL = 3;

/**
 * How far off a whole number of spacings a gap may fall and still be lines of one lattice.
 *
 * Board lines are evenly spaced, so this is what says whether a set of peaks is a grid or
 * a grid with something else mixed in. The widest a real fixture stretches it is 0.08, a
 * border sitting a little outside the line it doubles.
 */
const LATTICE_TOLERANCE = 0.15;

/**
 * How many times a lattice is re-fitted to the peaks it has gathered.
 *
 * A candidate starts life anchored on one peak with a pitch taken from one other, and that
 * is a shaky place to stay: any error in either is multiplied by the distance across the
 * board, so peaks at the far end fall outside the tolerance and are dropped for being where
 * a slightly wrong model did not expect them. Re-fitting by least squares spreads the error
 * over every peak instead of piling it up at one end, and the wider set that comes back is
 * fitted again.
 *
 * What this is for is a page photographed with a curl in it, where the columns tighten from
 * one edge of the board to the other — 34px down to 28px on the 9x9 that prompted it. No
 * single pitch anchored anywhere holds all nine of those lines: 34 loses the last by a third
 * of a cell, and the 32.6 spanning the board loses the middle three instead. Least squares
 * through the same peaks lands within a fifth of a pixel of every one of them.
 *
 * That board is no longer in the corpus — its stones defeated us for other reasons — so
 * nothing here exercises this today. It is kept because anchoring a lattice on one peak is
 * the wrong shape of answer regardless, and the next photographed page will want it.
 *
 * Three rounds because each one only ever adds peaks, so it settles quickly, and a round
 * that adds nothing stops the loop anyway.
 */
const REFIT_ROUNDS = 3;

/**
 * How far a line's measured position may sit from an evenly spaced fit and still be taken
 * as the fit being right and the measurement noisy, in pixels.
 *
 * A peak's centre is the midpoint of a run of ink, and a grid line broken up by the stones
 * standing on it produces a run a pixel or so off either side. Below this, believe the fit.
 */
const PEAK_DRIFT = 1.5;

/**
 * How many lines in a row may have gone unseen between two that were found.
 *
 * Only affects which spacings get proposed: a pair of peaks with three missing lines
 * between them still offers the right spacing, as long as we think to divide by four.
 */
const MAX_UNSEEN_RUN = 4;

/**
 * What an empty lattice position costs, against a line found being worth one.
 *
 * Lines do go missing — buried under a row of white stones, or lost by a photocopier — so a
 * reading has to be allowed gaps. But a reading is also free to halve its spacing, which
 * invents a position between every pair and can only pick up more peaks; charging for the
 * positions it invents is what stops that.
 *
 * Both failures this has to straddle are real. `has-label` offers a lattice at half pitch
 * that catches one extra peak across seven invented positions, and taking it loses the
 * board. `2026-08-13_09-39` has six of its nineteen rows buried under stones, and among
 * what is left sit eight peaks evenly spaced with no gaps at all — a tidier lattice by any
 * local measure than the true one. The first needs the charge above 0.14, the second needs
 * it below 0.45.
 */
const SPARSITY_COST = 0.3;

/**
 * Cuts to fall back on, as shares of the tallest peak, when nothing else is available.
 *
 * A board's border is drawn heavier than its grid, and some prints take that a long way: in
 * `2026-08-13_17-22` the border is solid black and the lines inside it are light enough that
 * binarising loses them altogether, leaving a dot where each pair crosses and nothing
 * between. A column of those dots is worth a *twelfth* of the border, so exactly one peak
 * stands above half the tallest — not enough to take a median height from, which is what
 * the usual cut is built on, and a reading that gives up there calls the picture unreadable.
 *
 * Used only in that case. Reaching this low as a matter of course was tried and measured,
 * and it is worse: at these levels the skirts of neighbouring lines merge into one run whose
 * centre falls between them, so a nineteen line board comes back as fifteen. Two generated
 * fixtures that read perfectly stopped being found at all.
 */
const FALLBACK_CUTS = [0.3, 0.2, 0.15, 0.1, 0.08];

/** How many readings of one axis to carry forward for the other axis to agree with. */
const MAX_CANDIDATES = 16;

/** How far apart the two axes may be about the size of a cell, which is square. */
const SQUARE_TOLERANCE = 0.08;

/** Below this many pixels between lines there is nothing left to classify. */
const MIN_SPACING = 6;

/** Fewer lines than this is not a board, whatever it is. */
const MIN_LINES = 5;

/**
 * How many of the perpendicular lines must carry on past the outermost one for the board
 * to be considered cut there rather than ended.
 *
 * Counting *which lines* continue rather than how much ink is out there, because plenty of
 * things sit in a board's margin without continuing anything: stones played on the edge
 * bulge past it, reference letters are printed outside it, and a caption under the diagram
 * puts a whole line of type there.
 *
 * Measured over every fixture — both ends of both axes, with the answer each one's own SGF
 * demands — a real cut carries at least 0.82 of the perpendicular lines and almost always
 * all of them, while a board edge reaches 0.50 at worst, three stones and a letter
 * overhanging the top row of `has-label`. The threshold sits in the gap between.
 */
const CUT_LINE_SHARE = 0.65;

/**
 * How far past the outermost line to look, once its own ink has been stepped over.
 *
 * A fixed offset cannot work. It has to clear the line itself, which for a border can be
 * four or five pixels thick, and still fit inside the margin, which in a tightly cropped
 * scan is five pixels total — so the near edge of any fixed window is already past the far
 * edge. Instead the line's own ink is walked over first, and the strip starts wherever
 * that ends. It stays short, well inside the three quarters of a spacing at which boards
 * print their coordinate labels.
 */
const MARGIN_BAND = 0.25;

/** The most bands `blankReach` will look through before calling the margin wide enough. */
const MOST_REACH = 12;

/**
 * How much of the ink the line itself carries must still be there for us to be standing on
 * it rather than past it.
 *
 * Measured against the line, not against the full width, because a board line is nowhere
 * near solid: every white stone sitting on it is a hole with an outline, and every black
 * one is a lump that spills over. The top row of `has-label` is broken up enough that the
 * line's own row is only 0.67 ink, so an absolute half-width test walks off it one pixel
 * early — leaving the strip beyond it lying across the line, which then reads as two extra
 * lines carrying on and turns a board edge into a crop.
 */
const ON_THE_LINE = 0.5;

/** Never walk further than this looking for the end of a line, as a share of the spacing. */
const MAX_LINE_THICKNESS = 0.4;

/**
 * Locate the board grid by projection.
 *
 * Board lines are long and axis-aligned, so summing ink down each column and across
 * each row puts a tall spike under every line. That is enough for scans and screen
 * renders; a photographed page with perspective or rotation will need deskewing
 * before this, which is why the projection stays a separate step.
 */
/**
 * Find the grid, and work out which board it is.
 *
 * `expected` forces a size where the caller already knows it — a fixture's own SGF, say.
 * Left out, the size is read off the picture.
 */
export function detectGrid(mask: BinaryImage, expected?: number): Grid {
  const largest = expected ?? BOARD_SIZES[0];
  const columns = new Uint32Array(mask.width);
  const rows = new Uint32Array(mask.height);

  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.dark[y * mask.width + x] === 1) {
        columns[x]++;
        rows[y]++;
      }
    }
  }

  // Fitted together, not one axis at a time, because the cells of a go board are square.
  // Bounded by the largest board there is, since which board it actually is is not known
  // until the edges have been found.
  const [acrossLattice, downLattice] = squarest(
    latticeCandidates(columns, largest),
    latticeCandidates(rows, largest),
  );

  const xs = fitLines(trimStray(acrossLattice), largest, 'vertical');
  const ys = fitLines(trimStray(downLattice), largest, 'horizontal');

  const spacing =
    ((xs[xs.length - 1] - xs[0]) / (xs.length - 1) + (ys[ys.length - 1] - ys[0]) / (ys.length - 1)) /
    2;

  if (!Number.isFinite(spacing) || spacing < MIN_SPACING) {
    throw new SgfCaptureError(
      `Detected a grid with only ${spacing.toFixed(1)}px between lines — the image is too small to read.`,
    );
  }

  const across = endsOf(mask, xs, ys, spacing, 'vertical');
  const down = endsOf(mask, xs, ys, spacing, 'horizontal');
  const size = inferSize(xs.length, ys.length, across, down);
  const boardSize = expected ?? size.size;

  const left = anchor(across, xs.length, boardSize, 'vertical');
  const top = anchor(down, ys.length, boardSize, 'horizontal');

  const region = { left: left.at, top: top.at, cols: xs.length, rows: ys.length };

  return {
    xs,
    ys,
    spacing,
    region,
    boardSize,
    sure: size.sure && left.sure && top.sure,
  };
}

/**
 * Which board this is, from the lines counted between the edges that are in view.
 *
 * An axis showing both of the board's edges has counted the board: whatever lies between
 * them is all of it. Where both axes have, they have to agree, because a board is square —
 * and a disagreement means one of the edges was misjudged, which is worth saying rather
 * than papering over.
 *
 * Where no axis is complete the picture simply does not say, and the largest board is the
 * assumption: a cropped corner of a 19 and of a 13 look alike, and 19 is what books print.
 */
function inferSize(
  cols: number,
  rows: number,
  across: Ends,
  down: Ends,
): { size: number; sure: boolean } {
  const complete = [
    across.start && across.end ? cols : 0,
    down.start && down.end ? rows : 0,
  ].filter((size) => size > 0);

  if (complete.length === 0) return { size: BOARD_SIZES[0], sure: true };

  // A board is square, so two complete axes that disagree are not two measurements of a board
  // — they are proof that one of the edge tests is wrong. A count that is not a board size at
  // all says the same thing. Neither is a reason to refuse the picture: both mean only that
  // the edges cannot say how big the board is, which is the position we are in anyway
  // whenever no edge is in view, and that case is already handled by assuming the largest.
  const disagree = complete.length === 2 && complete[0] !== complete[1];
  const size = disagree ? 0 : complete[0];
  const known = BOARD_SIZES.includes(size as (typeof BOARD_SIZES)[number]);

  // Nothing in view to say the size is not a doubt about the reading — it is the ordinary
  // case of a cropped diagram, and the largest board is the right assumption. A contradiction
  // is different, and is what `sure` is there to record.
  return { size: known ? size : BOARD_SIZES[0], sure: complete.length === 0 || known };
}

/**
 * Work out which board columns (or rows) the lines found correspond to.
 *
 * A diagram cropped to a corner has to be placed before its stones mean anything. The
 * tell is what lies beyond the outermost line: at the board's own edge there is nothing,
 * while at a crop the perpendicular lines carry on to the edge of the picture.
 */
function endsOf(
  mask: BinaryImage,
  xs: number[],
  ys: number[],
  spacing: number,
  axis: 'vertical' | 'horizontal',
): Ends {
  const along = axis === 'vertical' ? xs : ys;
  const across = axis === 'vertical' ? ys : xs;
  const limit = axis === 'vertical' ? mask.width : mask.height;

  return {
    start: isBlankBeyond(mask, along[0], -1, across, axis, spacing, limit),
    end: isBlankBeyond(mask, along[along.length - 1], 1, across, axis, spacing, limit),
    startReach: blankReach(mask, along[0], -1, across, axis, spacing, limit),
    endReach: blankReach(mask, along[along.length - 1], 1, across, axis, spacing, limit),
  };
}

/** Where the lines found start, on a board now known to be `boardSize` across. */
function anchor(
  ends: Ends,
  count: number,
  boardSize: number,
  axis: string,
): { at: number; sure: boolean } {
  if (ends.start && ends.end) {
    if (count === boardSize) return { at: 0, sure: true };

    // Both ends look like the board's edge and the count says they cannot both be. One of
    // them is a crop that happened to have nothing just past it, so the question is which,
    // and the answer is which one has more nothing: a board's real edge is followed by the
    // margin of the page, while a crop is followed by however much of the picture was left
    // over before the next thing starts. Refusing the diagram outright was the old answer and
    // it is the worst one — `photo-rotated` is a sideways photograph whose lattice is found
    // exactly right, 11 by 17, and thrown away for not being square.
    return { at: ends.startReach >= ends.endReach ? 0 : boardSize - count, sure: false };
  }

  if (ends.start) return { at: 0, sure: true };
  if (ends.end) return { at: boardSize - count, sure: true };

  throw new SgfCaptureError(
    `Could not place the diagram: neither ${axis} edge of the board is in view, so there is ` +
      `nothing to say which part of it this is.`,
  );
}

/**
 * How far past a line the picture stays free of continuing lines, in spacings.
 *
 * `isBlankBeyond` answers whether the board stops here; this answers how emphatically. At the
 * board's own edge the paper runs on to the margin of the page, while a crop that happens to
 * fall in a gap is clear only until the next thing along. Where both ends of an axis claim to
 * be the edge and the line count says only one of them can be, that difference is the only
 * evidence there is for which to believe.
 */
function blankReach(
  mask: BinaryImage,
  line: number,
  direction: -1 | 1,
  across: number[],
  axis: 'vertical' | 'horizontal',
  spacing: number,
  limit: number,
): number {
  const step = Math.max(1, Math.round(spacing * MARGIN_BAND));
  let reach = 0;

  for (let band = 0; band < MOST_REACH; band++) {
    const from = line + direction * (band * step + 1);
    const to = from + direction * step;
    if (from < 0 || from > limit - 1) break;
    const clamped = Math.min(Math.max(to, 0), limit - 1);
    const [low, high] = direction === 1 ? [from, clamped] : [clamped, from];
    if (crossingShare(mask, low, high, across, axis) >= CUT_LINE_SHARE) break;
    reach += 1;
  }

  return (reach * step) / spacing;
}

/**
 * Whether the strip just past a line is empty of continuing lines — that is, whether the
 * board ends here rather than being cut here.
 *
 * The line's own ink is stepped over first, so a thick border is not mistaken for its own
 * margin, and the strip then takes whatever room is left. Where there is no room at all
 * nothing can be concluded, and the answer is no: a crop is the safer assumption, since
 * guessing an edge would place every stone on the wrong point.
 */
function isBlankBeyond(
  mask: BinaryImage,
  line: number,
  direction: -1 | 1,
  across: number[],
  axis: 'vertical' | 'horizontal',
  spacing: number,
  limit: number,
): boolean {
  const within = (position: number) => position >= 0 && position <= limit - 1;

  // Walk off the line itself: along its length it is nearly all ink, and just past it is
  // not. How much "nearly all" is comes from the line, since stones break it up.
  //
  // Taken as the strongest row within a pixel either side, because `line` is a least-squares
  // estimate and lands on a fraction. Rounded the wrong way it names the margin rather than
  // the line: the reference then reads the handful of stubs poking past a crop instead of
  // the line's own ink, the walk treats those stubs as the line it is stepping off, and
  // marches clean past the evidence that the board carries on. Which is how a cropped
  // diagram came to be read as a whole board seven lines short.
  const onLine =
    Math.max(
      lineDensity(mask, line - 1, across, axis),
      lineDensity(mask, line, across, axis),
      lineDensity(mask, line + 1, across, axis),
    ) * ON_THE_LINE;
  let offset = 1;
  while (
    offset <= spacing * MAX_LINE_THICKNESS &&
    within(line + direction * offset) &&
    lineDensity(mask, line + direction * offset, across, axis) > onLine
  ) {
    offset++;
  }

  const from = line + direction * offset;
  const to = line + direction * (offset + spacing * MARGIN_BAND);
  if (!within(from)) return false;

  const clamped = within(to) ? to : direction === 1 ? limit - 1 : 0;
  const [low, high] = direction === 1 ? [from, clamped] : [clamped, from];

  return crossingShare(mask, low, high, across, axis) < CUT_LINE_SHARE;
}

/** Fraction of a line's length that is ink, used to tell when we have stepped off it. */
function lineDensity(
  mask: BinaryImage,
  position: number,
  across: number[],
  axis: 'vertical' | 'horizontal',
): number {
  const from = Math.round(across[0]);
  const to = Math.round(across[across.length - 1]);
  let ink = 0;
  let total = 0;

  for (let b = from; b <= to; b++) {
    const x = axis === 'vertical' ? Math.round(position) : b;
    const y = axis === 'vertical' ? b : Math.round(position);
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;

    total++;
    if (isDark(mask, x, y)) ink++;
  }

  return total === 0 ? 0 : ink / total;
}


/**
 * The share of perpendicular lines that still show ink in the strip beyond the outermost
 * line — that is, how many of them carry on past it.
 */
function crossingShare(
  mask: BinaryImage,
  from: number,
  to: number,
  across: number[],
  axis: 'vertical' | 'horizontal',
): number {
  let crossing = 0;

  for (const position of across) {
    let found = false;

    for (let a = Math.round(from); a <= Math.round(to) && !found; a++) {
      // A pixel either side too, so a line that wanders slightly still counts.
      for (let offset = -1; offset <= 1 && !found; offset++) {
        const b = Math.round(position) + offset;
        const x = axis === 'vertical' ? a : b;
        const y = axis === 'vertical' ? b : a;
        if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;

        if (isDark(mask, x, y)) found = true;
      }
    }

    if (found) crossing++;
  }

  return across.length === 0 ? 1 : crossing / across.length;
}

/**
 * Find the lines in a projection profile, as the centre of each run of bins that stand
 * above what a line here looks like.
 *
 * Measuring against the tallest peak does not work, because the tallest peak is usually
 * not a line. A board's outer border is drawn heavier than its grid, and it runs the full
 * width of the diagram, so it towers over the lines inside; meanwhile a row of white
 * stones erases the line beneath it, since a white stone is a hole with an outline. Put
 * together — a heavy border and a crowded position — an interior line can carry a third of
 * the ink the border does and still be a line.
 *
 * So the strongest peaks are found first only to ask how tall a line around here tends to
 * be, and the profile is then cut again at a share of that. The median is what makes it
 * work: the border is one peak among many and cannot move it.
 *
 * Neither cut is trusted as it stands. A projection is taken over the whole picture, so
 * anything else on the page lands in it too: a caption under the diagram, a line of body
 * text the screenshot caught, the bands of ink across a cluster of numbered stones. Each
 * reading is therefore reduced to the peaks that sit on one evenly spaced lattice, and the
 * one left with more lines wins. Even spacing is the one thing a grid does and stray ink
 * does not, and it is the only property here that does not depend on how dark anything is.
 */
function latticeCandidates(profile: Uint32Array, boardSize: number): Lattice[] {
  let max = 0;
  for (const value of profile) if (value > max) max = value;

  const strongest = runsAbove(profile, max * PEAK_RATIO);

  // Where enough peaks stand above half the tallest to say what a line looks like around
  // here, that is the cut to use, and reaching below it only does harm — tried, and it costs
  // two fixtures that were perfect. Where there are not, the alternative is giving up.
  //
  // Tried again, and it still does harm. On a photograph `max` really is two to seven times
  // an ordinary line, because body text and dense stones pile ink into a row the way a grid
  // line never does, so the cut here really does sit above lines that are plainly there.
  // Seeding the typical from a low cut finds them — and hands `onOneLattice` so many spurious
  // peaks that it starts preferring lattices that are not the board: `2026-08-14_10-33` comes
  // back as a 9x9. What is wanted is not a lower bar but less rubbish to measure, which means
  // knowing where the board is before profiling it, not after.
  const cuts =
    strongest.length >= MIN_PEAKS_FOR_TYPICAL
      ? [max * PEAK_RATIO, median(strongest.map((run) => run.height)) * PEAK_RATIO]
      : [max * PEAK_RATIO, ...FALLBACK_CUTS.map((share) => max * share)];

  // Merged by pitch, not concatenated: the same pitch found at two cuts is one reading, and
  // leaving the copies in fills the shortlist with duplicates. That is not cosmetic — the
  // list is capped, and the reading the other axis needs can be crowded off the end of it.
  const byPitch = new Map<number, Lattice>();
  for (const reading of cuts.map((cut) => runsAbove(profile, cut).map((run) => run.centre))) {
    for (const lattice of onOneLattice(reading, boardSize)) {
      const pitch = Math.round(lattice.spacing);
      const held = byPitch.get(pitch);
      if (held === undefined || lattice.score > held.score) byPitch.set(pitch, lattice);
    }
  }

  // Best first, so the axis that is sure of itself leads and the other follows.
  return [...byPitch.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

/**
 * How badly a set of positions fits an even lattice, as a share of the spacing.
 *
 * Least squares through them, and the worst any one of them misses by. Nought is a lattice;
 * `LATTICE_TOLERANCE` is the most that is still called one.
 */
function outOfTrue(positions: number[], spacing: number): number {
  const n = positions.length;
  if (n < 3 || !(spacing > 0)) return 0;

  // Which line each position is, counted in spacings from the first — not simply its place in
  // the list. Lines go missing all the time, buried under a row of stones or lost by a
  // photocopier, and numbering the survivors one after another turns a perfectly even board
  // with a gap in it into a badly distorted one. `fitLines` numbers them this way for the same
  // reason, and getting it wrong here trimmed two real columns off an untouched generated
  // diagram.
  const indices = [0];
  for (let i = 1; i < n; i++) {
    indices.push(indices[i - 1] + Math.max(1, Math.round((positions[i] - positions[i - 1]) / spacing)));
  }

  const meanIndex = indices.reduce((total, value) => total + value, 0) / n;
  const meanPosition = positions.reduce((total, value) => total + value, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    covariance += (indices[i] - meanIndex) * (positions[i] - meanPosition);
    variance += (indices[i] - meanIndex) * (indices[i] - meanIndex);
  }
  if (variance === 0) return 0;

  const step = covariance / variance;
  if (!(step > 0)) return 0;
  const origin = meanPosition - step * meanIndex;

  return Math.max(...positions.map((value, i) => Math.abs(value - (origin + indices[i] * step)))) / step;
}

/**
 * How far out of true a lattice has to be before an end line is suspected of not belonging,
 * and how much better it has to fit without it.
 *
 * A book prints a caption under its diagram, and a caption is a row of ink lying parallel to
 * the board a little further away than a line would. It survives every test made of it in
 * isolation — it is dark enough to be a peak, it has blank paper beyond it as a board's edge
 * does, and it lands near enough to the lattice to be taken in once the fit stretches to meet
 * it. What gives it away is that stretch. `2026-08-20_00-37` reads eleven rows and a caption
 * as twelve rows, and doing so pulls the fit to 0.151 out of true, which is as far as the
 * tolerance stretches; without the caption the same rows sit at 0.048.
 *
 * Measured over every fixture, no genuine end line distorts its lattice anywhere near this
 * much — the worst is 0.094, and dropping it improves nothing. The pair of thresholds is what
 * keeps a merely untidy lattice, of which there are several, from being trimmed.
 */
const STRAY_SLACK = 0.1;
const STRAY_IMPROVEMENT = 2;

/**
 * The lattice again, less an end line that is plainly not on it.
 *
 * Only ever one, and only from an end: a line in the middle cannot be a caption, and one that
 * does not fit there is a misreading of the board rather than something printed beside it.
 */
function trimStray(lattice: Lattice): Lattice {
  const positions = lattice.positions;
  if (positions.length < MIN_LINES + 1) return lattice;

  const before = outOfTrue(positions, lattice.spacing);
  if (before <= STRAY_SLACK) return lattice;

  const withoutLast = positions.slice(0, -1);
  const withoutFirst = positions.slice(1);
  const last = outOfTrue(withoutLast, lattice.spacing);
  const first = outOfTrue(withoutFirst, lattice.spacing);

  const kept = last <= first ? withoutLast : withoutFirst;
  const after = Math.min(last, first);
  if (after * STRAY_IMPROVEMENT > before) return lattice;

  return { ...lattice, positions: kept };
}

function gapsBetween(positions: number[]): number[] {
  return positions.slice(1).map((position, i) => position - positions[i]);
}

/** Evenly spaced lines, as the line at index zero and the distance between them. */
interface LineModel {
  origin: number;
  step: number;
}

/** Which peaks this model explains, at most one per line and the nearest one at that. */
function onModel(
  positions: number[],
  model: LineModel,
): Map<number, { position: number; error: number }> {
  const taken = new Map<number, { position: number; error: number }>();

  for (const position of positions) {
    const exact = (position - model.origin) / model.step;
    const index = Math.round(exact);
    const error = Math.abs(exact - index);
    if (error > LATTICE_TOLERANCE) continue;

    const held = taken.get(index);
    if (held === undefined || error < held.error) taken.set(index, { position, error });
  }

  return taken;
}

/**
 * The evenly spaced lines that best explain the peaks gathered so far, by least squares.
 *
 * Returns null where there is nothing to fit — fewer than two peaks, or every peak on one
 * line — and where the fit comes back with a pitch that is not a positive number.
 */
function refit(taken: Map<number, { position: number; error: number }>): LineModel | null {
  if (taken.size < 2) return null;

  let sumIndex = 0;
  let sumPosition = 0;
  for (const [index, { position }] of taken) {
    sumIndex += index;
    sumPosition += position;
  }

  const meanIndex = sumIndex / taken.size;
  const meanPosition = sumPosition / taken.size;

  let covariance = 0;
  let variance = 0;
  for (const [index, { position }] of taken) {
    covariance += (index - meanIndex) * (position - meanPosition);
    variance += (index - meanIndex) * (index - meanIndex);
  }
  if (variance === 0) return null;

  const step = covariance / variance;
  if (!Number.isFinite(step) || step <= 0) return null;

  return { origin: meanPosition - step * meanIndex, step };
}

/**
 * Pick the reading of each axis that agrees with the other about how big a cell is.
 *
 * A go board's cells are square, and nothing else in the picture has to be — so where two
 * readings of one axis are otherwise hard to choose between, the one matching the other
 * axis is right. It is the strongest prior available and costs nothing to apply.
 *
 * `2026-08-13_09-39` is what it is for. Six of its horizontal lines are buried under stones,
 * and among what is left sit eight peaks that happen to be evenly spaced 57 apart with no
 * gaps — a tidier lattice, by any measure taken down that axis alone, than the true one at
 * 21.5 with six lines missing. The columns are unambiguous at 21.5, and that settles it.
 */
function squarest(across: Lattice[], down: Lattice[]): [Lattice, Lattice] {
  let best: [Lattice, Lattice] | null = null;
  let mostLines = -Infinity;

  for (const x of across) {
    for (const y of down) {
      const difference = Math.abs(x.spacing - y.spacing) / Math.max(x.spacing, y.spacing);
      if (difference > SQUARE_TOLERANCE) continue;

      if (x.score + y.score > mostLines) {
        mostLines = x.score + y.score;
        best = [x, y];
      }
    }
  }

  // No pair agrees: the picture is not a board, or one axis is too far gone to say. Hand
  // back each axis's own best and let the checks downstream report what is wrong with it.
  const nothing: Lattice = { positions: [], spacing: 1, score: 0 };
  return best ?? [across[0] ?? nothing, down[0] ?? nothing];
}

export interface Lattice {
  positions: number[];
  spacing: number;
  /** Lines found, less a charge for the lattice positions left empty. */
  score: number;
}

/**
 * The best group of these positions that lie on one evenly spaced lattice.
 *
 * Every pair of positions proposes a spacing — theirs, and theirs divided by two, three
 * and four in case the lines between them went unseen — and each proposal is scored by how
 * much of the board it accounts for. What does not fit is dropped, which is how ink that
 * has nothing to do with the board leaves the picture.
 *
 * Two things stop a spacing from winning by being fine enough to cover everything. A
 * lattice needing more points than the board has is refused outright. And what is scored is
 * not the count of positions explained but that count less the lattice positions left
 * empty, so halving the spacing has to find a peak at every new position it invents to
 * break even. Without the second, a diagram cropped to eight lines is read at half spacing
 * across fifteen, which picks up one stray peak and shifts every stone by half a point.
 *
 * A lattice position holds at most one peak, the nearest. Two runs either side of one line
 * — a thick border, or a line the threshold broke in half — otherwise both count, and the
 * board comes out a line wider than it is.
 */
function onOneLattice(positions: number[], boardSize: number): Lattice[] {
  if (positions.length < MIN_PEAKS_FOR_TYPICAL) {
    return [{ positions, spacing: median(gapsBetween(positions)) || 1, score: positions.length }];
  }

  // Keyed by spacing, because two lattices of the same pitch are the same reading however
  // they were arrived at, and the rest of the search would otherwise return it many times.
  const byPitch = new Map<number, Lattice>();

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      for (let steps = 1; steps <= MAX_UNSEEN_RUN; steps++) {
        const spacing = (positions[j] - positions[i]) / steps;
        if (spacing < MIN_SPACING) continue;

        // Seeded from the pair, then re-fitted to whatever it gathers — see `REFIT_ROUNDS`.
        let model: LineModel = { origin: positions[i], step: spacing };
        let taken = onModel(positions, model);

        for (let round = 0; round < REFIT_ROUNDS; round++) {
          const refined = refit(taken);
          if (refined === null || refined.step < MIN_SPACING) break;

          const wider = onModel(positions, refined);
          if (wider.size <= taken.size) break;

          model = refined;
          taken = wider;
        }

        const indices = [...taken.keys()].sort((a, b) => a - b);
        if (indices.length < MIN_PEAKS_FOR_TYPICAL) continue;

        // How wide the lattice has to be to hold them, against how many sit on it.
        const span = indices[indices.length - 1] - indices[0] + 1;
        if (span > boardSize) continue;

        const score = indices.length - span * SPARSITY_COST;
        // To the nearest pixel: a fit differing by a fifth of one is the same reading, and
        // keeping both crowds out the readings that genuinely differ.
        const pitch = Math.round(model.step);
        const held = byPitch.get(pitch);
        if (held === undefined || score > held.score) {
          byPitch.set(pitch, {
            positions: indices.map((index) => taken.get(index)!.position),
            spacing: model.step,
            score,
          });
        }
      }
    }
  }

  // Nothing lined up at all. Hand back what was found and let the checks downstream report
  // the trouble; there is more to say about a grid that does not add up than about nothing.
  if (byPitch.size === 0) {
    return [{ positions, spacing: median(gapsBetween(positions)) || 1, score: positions.length }];
  }

  return [...byPitch.values()];
}

/** Collapse each run of bins at or above `threshold` into its centre and its tallest bin. */
function runsAbove(
  profile: Uint32Array,
  threshold: number,
): Array<{ centre: number; height: number }> {
  const runs: Array<{ centre: number; height: number }> = [];
  let runStart = -1;
  let height = 0;

  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= threshold) {
      if (runStart < 0) {
        runStart = i;
        height = 0;
      }
      if (profile[i] > height) height = profile[i];
    } else if (runStart >= 0) {
      runs.push({ centre: (runStart + i - 1) / 2, height });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ centre: (runStart + profile.length - 1) / 2, height });

  return runs;
}

/**
 * Fit `origin + index * spacing` through the detected positions and return the fitted
 * line positions rather than the raw ones.
 *
 * Not every line has to have been found. Photocopied and rescanned book diagrams lose
 * faint lines completely, and two lines can merge into one run. What survives is the
 * regularity: the gaps between the lines we did find are all near-multiples of one
 * spacing, so each is given a lattice index and the missing ones are interpolated.
 *
 * Fitting across all of them also beats trusting any single peak, which drifts when a
 * stone thickens a line or antialiasing smears it.
 */
function fitLines(lattice: Lattice, boardSize: number, axis: string): number[] {
  const positions = lattice.positions;
  if (positions.length < MIN_LINES) {
    throw new SgfCaptureError(
      `Found only ${positions.length} ${axis} lines, too few to read a board from.`,
    );
  }

  // The pitch comes from the lattice that was chosen, not from the median gap of what is
  // left. Where two lines in three are buried the surviving gaps are all three cells wide,
  // and re-deriving from them fits a board a third the size — undoing the choice the two
  // axes just made together.
  const gaps = positions.slice(1).map((position, i) => position - positions[i]);
  const spacing = lattice.spacing;
  if (!(spacing > 0)) {
    throw new SgfCaptureError(`Could not measure the ${axis} line spacing.`);
  }

  // Number the lines we found. A gap of roughly twice the spacing means one line in
  // between went unseen, so the index jumps rather than the board being read as narrower.
  const indices = [0];
  for (let i = 1; i < positions.length; i++) {
    const step = Math.max(1, Math.round(gaps[i - 1] / spacing));
    indices.push(indices[i - 1] + step);
  }

  const count = indices[indices.length - 1] + 1;
  if (count > boardSize) {
    throw new SgfCaptureError(
      `The ${axis} lines span ${count} points, more than a ${boardSize}x${boardSize} board.`,
    );
  }

  const n = positions.length;
  const meanIndex = indices.reduce((total, value) => total + value, 0) / n;
  const meanPosition = positions.reduce((total, value) => total + value, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    covariance += (indices[i] - meanIndex) * (positions[i] - meanPosition);
    variance += (indices[i] - meanIndex) * (indices[i] - meanIndex);
  }

  const step = covariance / variance;
  const origin = meanPosition - step * meanIndex;

  // Evenly spaced lines, then any line the picture puts somewhere else by more than a peak
  // centre can drift moved to where the picture puts it.
  //
  // Even spacing is the right model for a flat board photographed square on, and smoothing
  // the peaks onto it is worth doing: a peak centre is a run midpoint, so a line broken by
  // the stones sitting on it comes back a pixel out either way, and the fit averages that
  // away. But a page with a curl in it is not evenly spaced at all: on the 9x9 that prompted
  // this the columns ran 34px apart at one edge and 28px at the other, and an even fit landed
  // two and a half pixels off in the middle — far enough that the test for grid lines showing
  // through a point missed them completely and a bare crossing was read as a stone.
  //
  // So the fit is kept where it disagrees only by noise and overridden where it disagrees by
  // more, which is what a systematic distortion looks like. Getting that distinction right is
  // the whole of it: taking the measured position every time flips a stone's colour in
  // `compressed`, whose peaks are noisy at 19px spacing and want the smoothing.
  const lines = Array.from({ length: count }, (_, i) => origin + i * step);
  indices.forEach((index, i) => {
    if (Math.abs(positions[i] - lines[index]) > PEAK_DRIFT) lines[index] = positions[i];
  });

  return lines;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
