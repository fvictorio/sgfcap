import type { RgbaImage } from '../types.js';

/** Ink/background mask: 1 where a pixel is dark enough to be part of the drawing. */
export interface BinaryImage {
  readonly width: number;
  readonly height: number;
  readonly dark: Uint8Array;
  /** The luminance cutoff Otsu picked. Worth looking at when a scan reads badly. */
  readonly threshold: number;
}

/**
 * How much of the lighter class has to sit apart from the paper for a second threshold to
 * be believed, and how far apart the two classes' means have to be.
 *
 * A page with nothing between its ink and its paper will still yield *some* split of the
 * lighter class, and taking it would turn antialiasing and scanner noise into ink. These
 * ask for a population big enough and distinct enough to be a real third thing.
 */
const GREY_SHARE = 0.005;
const GREY_SEPARATION = 40;

/**
 * How much more of the lighter class has to lie above the second split than below it.
 *
 * Because the thing being looked for is *paper with something darker drawn on it*, and paper
 * is the most common thing on a page. Without this the split is just as happy the other way
 * up: a board rendered on tan has its stones as the lighter minority, the second Otsu
 * separates tan from white, and the whole board becomes ink.
 */
const PAPER_DOMINANCE = 3;

/**
 * Split the image into ink and background.
 *
 * The threshold is chosen per image by Otsu's method rather than fixed, so that a
 * grey scan or a photo with uneven exposure still separates. On the clean synthetic
 * boards this lands somewhere harmless in the empty middle of the histogram.
 */
export function binarize(image: RgbaImage, level: 'ink' | 'structure' = 'ink'): BinaryImage {
  const pixels = image.width * image.height;
  const luminance = new Uint8Array(pixels);
  const histogram = new Uint32Array(256);

  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    // Composite over white, so a transparent PNG background reads as background
    // rather than as ink.
    const alpha = image.data[i + 3] / 255;
    const r = image.data[i] * alpha + 255 * (1 - alpha);
    const g = image.data[i + 1] * alpha + 255 * (1 - alpha);
    const b = image.data[i + 2] * alpha + 255 * (1 - alpha);

    const value = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    luminance[p] = value;
    histogram[value]++;
  }

  const threshold =
    level === 'ink' ? otsuThreshold(histogram, pixels) : structureThreshold(histogram, pixels);
  const dark = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) dark[p] = luminance[p] <= threshold ? 1 : 0;

  return { width: image.width, height: image.height, dark, threshold };
}

/**
 * A cutoff that keeps anything that is not paper, grid lines included.
 *
 * Otsu splits an image in two, and a printed diagram is often three things: paper, the ink
 * of the stones, and a grid drawn in grey between them. Asked for two classes it puts the
 * grey with whichever it resembles more — and in `2026-08-13_17-22` that is the paper, so
 * the entire grid vanishes from the mask and only the crossings survive, where two lines
 * overlap and darken enough to fall the other way.
 *
 * So Otsu is run a second time on the lighter class alone. Where that class really is two
 * things, the split lands between the grey and the paper and the lines come back. Where it
 * is only paper, the split is meaningless and is refused: it has to separate a population
 * worth noticing, and separate it by a real distance.
 *
 * Only the grid detector wants this. Telling a black stone from a white one, or a numeral
 * from the stone it sits on, wants the ordinary threshold — a mask where grey counts as ink
 * would make every white stone black.
 */
export function structureThreshold(histogram: Uint32Array, total: number): number {
  const ink = otsuThreshold(histogram, total);

  const lighter = new Uint32Array(256);
  let lighterTotal = 0;
  for (let i = ink + 1; i < 256; i++) {
    lighter[i] = histogram[i];
    lighterTotal += histogram[i];
  }
  if (lighterTotal === 0) return ink;

  const split = otsuThreshold(lighter, lighterTotal);

  let below = 0;
  let belowSum = 0;
  let above = 0;
  let aboveSum = 0;
  for (let i = ink + 1; i < 256; i++) {
    if (i <= split) {
      below += lighter[i];
      belowSum += i * lighter[i];
    } else {
      above += lighter[i];
      aboveSum += i * lighter[i];
    }
  }

  if (below < total * GREY_SHARE || above === 0) return ink;
  if (above < below * PAPER_DOMINANCE) return ink;
  if (aboveSum / above - belowSum / below < GREY_SEPARATION) return ink;

  return split;
}

/**
 * How far apart the two classes inside a stone must sit, and how much of it the lighter one
 * may be, before a local threshold is believed.
 *
 * A plain black stone is one flat tone, and Otsu asked to split it will still split it —
 * somewhere in the noise, calling half of it light and inventing a shape out of nothing. So
 * a split is only taken where it looks like a number printed on a stone rather than a line
 * drawn through fog: the two sides genuinely far apart, and the lighter one a minority of
 * the disc, which is what a digit is.
 *
 * Measured over every black stone in the corpus. Those carrying a number or a mark separate
 * by 55 at the first percentile and their light side covers a tenth to four tenths of the
 * disc; plain ones separate by 40 at the median. The bands below sit under the first and
 * around the second, and where they refuse, the ordinary mask is used exactly as before.
 */
const STONE_SEPARATION = 50;

/**
 * How far the shine on a stone has to sit below the number printed on it before the two are
 * told apart, in luminance.
 *
 * Wide, because getting this wrong eats the digit: a stone with no highlight has only the
 * number up there, and splitting that in half leaves half a numeral.
 */
const SHINE_SEPARATION = 45;

/**
 * How far off the middle the dimmer light has to sit, as a share of the stone's radius,
 * before it is taken for a reflection rather than part of the number.
 */
const SHINE_OFFSET = 0.3;
const STONE_LIGHT_MIN = 0.06;
const STONE_LIGHT_MAX = 0.45;

/**
 * The mask again, with the inside of each of these stones judged against itself.
 *
 * One threshold cannot answer two questions at once. Otsu picks the cutoff that best divides
 * a whole page into ink and paper, and on a page of mostly paper that lands high — in
 * `2026-08-14_10-45` at 199. The white number printed on a black stone reaches 191, so it
 * falls on the ink side along with the stone it is printed on, and every numbered black
 * stone in the diagram reads as a plain one. Nothing is misread; the digits simply are not
 * there to read.
 *
 * Inside one stone the question is a different one — which of these pixels are the stone and
 * which are the number — and asked of the stone alone Otsu answers it easily, at 104 rather
 * than 199. So each stone gets its own cutoff, and only its own disc is rewritten.
 *
 * Black stones only. A number on a white stone is dark on light, the same way round as the
 * page, so the ordinary threshold already separates it.
 */
export function localizeStones(
  image: RgbaImage,
  mask: BinaryImage,
  centres: ReadonlyArray<{ cx: number; cy: number }>,
  radius: number,
): BinaryImage {
  if (centres.length === 0) return mask;

  const dark = new Uint8Array(mask.dark);
  const reach = Math.round(radius);

  for (const { cx, cy } of centres) {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);

    const histogram = new Uint32Array(256);
    let total = 0;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > reach * reach) continue;
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        histogram[luminanceAt(image, (y * image.width + x) * 4)]++;
        total++;
      }
    }
    if (total === 0) continue;

    const split = otsuThreshold(histogram, total);
    let below = 0;
    let belowSum = 0;
    let above = 0;
    let aboveSum = 0;
    for (let i = 0; i < 256; i++) {
      if (i <= split) {
        below += histogram[i];
        belowSum += i * histogram[i];
      } else {
        above += histogram[i];
        aboveSum += i * histogram[i];
      }
    }
    if (below === 0 || above === 0) continue;
    if (aboveSum / above - belowSum / below < STONE_SEPARATION) continue;

    let light = above / total;
    if (light < STONE_LIGHT_MIN || light > STONE_LIGHT_MAX) continue;

    // A glossy stone is lit as well as printed on, and the two do not separate in one cut.
    // Boards rendered by a playing program give their stones a specular highlight — a bright
    // arc across the shoulder — and against the dark of the stone that highlight lands on the
    // same side of the cutoff as the white number. Being connected to it at that cutoff, it
    // becomes part of the same shape, and `2026-08-14_10-29` duly reads its 1 as a 3 or a 5
    // with a wedge of shine welded to the stem.
    //
    // The number is painted on and the highlight is reflected off, so the number is the
    // brighter of the two and a second cut through the light class separates them. Only taken
    // where it looks like that situation: two clearly separated levels, with the brighter one
    // still a plausible size for a numeral. A stone with no shine has nothing up there to
    // split and is left alone.
    let cut = split;
    const shine = new Uint32Array(256);
    let shineTotal = 0;
    for (let i = split + 1; i < 256; i++) {
      shine[i] = histogram[i];
      shineTotal += histogram[i];
    }
    if (shineTotal > 0) {
      const brighter = otsuThreshold(shine, shineTotal);
      let dim = 0;
      let dimSum = 0;
      let lit = 0;
      let litSum = 0;
      for (let i = split + 1; i < 256; i++) {
        if (i <= brighter) {
          dim += shine[i];
          dimSum += i * shine[i];
        } else {
          lit += shine[i];
          litSum += i * shine[i];
        }
      }
      // Where the dimmer of the two sits, which is what says whether it is a highlight at
      // all. A number is printed in the middle of the stone; a reflection is thrown off one
      // shoulder and lies well to one side. Luminance alone cannot tell them apart — a
      // faintly printed numeral is dimmer than a bold one — but position can, and it is the
      // difference between splitting a stone that is lit and cutting a numeral in half.
      let offX = 0;
      let offY = 0;
      let count = 0;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dy * dy > reach * reach) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const value = luminanceAt(image, (y * image.width + x) * 4);
          if (value <= split || value > brighter) continue;
          offX += dx;
          offY += dy;
          count++;
        }
      }
      const offset = count === 0 ? 0 : Math.hypot(offX / count, offY / count) / reach;

      const share = lit / total;
      if (
        dim > 0 &&
        lit > 0 &&
        offset >= SHINE_OFFSET &&
        litSum / lit - dimSum / dim >= SHINE_SEPARATION &&
        share >= STONE_LIGHT_MIN
      ) {
        cut = brighter;
        light = share;
      }
    }

    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > reach * reach) continue;
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        const at = y * image.width + x;
        dark[at] = luminanceAt(image, at * 4) <= cut ? 1 : 0;
      }
    }
  }

  return { width: mask.width, height: mask.height, dark, threshold: mask.threshold };
}

function luminanceAt(image: RgbaImage, at: number): number {
  const alpha = image.data[at + 3] / 255;
  const r = image.data[at] * alpha + 255 * (1 - alpha);
  const g = image.data[at + 1] * alpha + 255 * (1 - alpha);
  const b = image.data[at + 2] * alpha + 255 * (1 - alpha);

  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function isDark(mask: BinaryImage, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.dark[y * mask.width + x] === 1;
}

/** The luminance cutoff that maximises between-class variance. */
export function otsuThreshold(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    backgroundWeight += histogram[t];
    if (backgroundWeight === 0) continue;

    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;

    backgroundSum += t * histogram[t];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const spread = backgroundMean - foregroundMean;
    const variance = backgroundWeight * foregroundWeight * spread * spread;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }

  return best;
}
