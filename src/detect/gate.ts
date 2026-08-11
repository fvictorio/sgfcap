/**
 * Whether anything is printed on a bare point.
 *
 * This is the question that decides if the glyph reader is ever asked about a point, and
 * getting it wrong is expensive in one direction in particular. `readPointLabel` is only
 * ever asked *which* character this is; handed a bare crossing it has no way to answer
 * "none", so it returns its closest match and a letter appears on the board that was never
 * printed. Measured across the corpus, offered every empty point the reader accepts 435 of
 * them — board corners whose L and T shapes read as b, c, d or f, and star points whose dot
 * and stubs of line read as f.
 *
 * What stood here was a single threshold on how much of the grid line survives through a
 * point, on the reasoning that a letter is printed in place of the lines. That is a true
 * observation and too narrow a one: the lines also read as broken where a neighbouring stone
 * overlaps the crossing, where the lattice sits a pixel or two off, and where the printing is
 * simply faint. Sixteen labels across the corpus come from exactly those cases.
 *
 * So the whole neighbourhood is looked at instead of one number taken from it. A printed
 * letter is a compact shape in the middle of an erased gap; a bare crossing is two lines
 * running straight through. Those are easy to tell apart when you can see them, which is an
 * argument for a model over a threshold rather than for a better threshold.
 */
import { best, forward, INPUT, makeWorkspace, TENSORS, softmax, type Net, type TensorName, type Workspace } from './net.js';
import { GATE_CLASSES, GATE_WEIGHTS, type QuantisedTensor } from './gateWeights.js';
import { imageLevels, intersectionPatch, PATCH, type Levels } from './patch.js';
import type { RgbaImage } from '../types.js';
import type { BinaryImage } from './binarize.js';

/**
 * How sure the gate has to be that something is printed before the reader is asked.
 *
 * Set far above a half, because the two mistakes do not cost the same. A gate that closes on
 * a real letter loses one claim. A gate that opens on a bare crossing invents one — and an
 * invented label is worse than a missing one, since it puts a mark on the board that was
 * never on the page and that whoever reads the diagram has to know to delete.
 *
 * Chosen on the books outside the held-out sources, the same ones that choose which epoch to
 * keep, and it is the only value that gets all of them right. The held-out sources then agree
 * — nothing invented, nothing missed — which is a real answer rather than a fitted one, since
 * they had no say in it.
 *
 * The margin behind that is thin and worth knowing about: across every bare point in the
 * corpus the faintest real letter scores 0.99906 and the boldest bare crossing 0.99876. The
 * model is emphatic almost everywhere — letters sit above 0.9999 and crossings near zero —
 * but its tails very nearly touch, and the few that come close are board corners, whose L of
 * heavy border is the one bare thing that genuinely looks printed. A new book with an unusual
 * corner is where this will fail first, and the fix when it does is more corners to train on
 * rather than another decimal place here.
 */
const MIN_CONFIDENCE = 0.999;

/** The class meaning nothing is printed here. Everything else means the reader should look. */
const NOTHING = 'none';

function dequantise(tensor: QuantisedTensor): Float32Array {
  const bytes =
    typeof atob === 'function'
      ? Uint8Array.from(atob(tensor.data), (c) => c.charCodeAt(0))
      : new Uint8Array(Buffer.from(tensor.data, 'base64'));

  const values = new Float32Array(bytes.length);
  // Stored as two's complement in a byte, so anything above 127 is negative.
  for (let i = 0; i < bytes.length; i++) values[i] = ((bytes[i] << 24) >> 24) * tensor.scale;

  return values;
}

/**
 * How many points are judged in one pass of the net.
 *
 * The convolutions are a matrix multiply that reads four output columns at a time, so asking
 * about one point at a time leaves three quarters of that work unused — and a board has three
 * hundred and sixty of them. Batching is worth roughly three times the speed.
 *
 * Bounded rather than a whole board at once because the intermediate feature maps are what
 * cost the memory, not the patches: a full 19x19 in one pass wants some eighty megabytes of
 * them, which is not a reasonable thing to allocate in a browser tab.
 */
const BATCH = 64;

let loaded: { net: Net; space: Workspace; patches: Float32Array } | null = null;

/** Built on first use rather than at import, so a page that never converts pays nothing. */
function model() {
  if (loaded) return loaded;

  const weights = {} as Record<TensorName, Float32Array>;
  const biases = {} as Record<TensorName, Float32Array>;
  for (const name of TENSORS) {
    weights[name] = dequantise(GATE_WEIGHTS[name]);
    biases[name] = dequantise(GATE_WEIGHTS[`${name}Bias`]);
  }

  loaded = {
    net: { classes: GATE_CLASSES, weights, biases },
    space: makeWorkspace(BATCH, GATE_CLASSES.length),
    patches: new Float32Array(BATCH * PATCH * PATCH),
  };

  return loaded;
}

/** Whether a gate has been trained yet — `gateWeights.ts` is empty until `pnpm train-gate` runs. */
export function isGateTrained(): boolean {
  return GATE_CLASSES.length > 0;
}

export { imageLevels, type Levels };

/**
 * Whether this point carries printing, or null where no gate has been trained.
 *
 * Null rather than a guess, so the caller falls back to the threshold it used before instead
 * of quietly treating an untrained model as one that found nothing.
 */
export function carriesPrint(
  image: RgbaImage,
  levels: Levels,
  cx: number,
  cy: number,
  spacing: number,
): boolean | null {
  return carriesPrintAll(image, levels, [{ cx, cy }], spacing)?.[0] ?? null;
}

/** One point to ask about, in pixels. */
export interface At {
  cx: number;
  cy: number;
}

/**
 * The same question asked of many points at once, which is how a board should ask it.
 *
 * Same answers as calling `carriesPrint` on each — the net is the same and so is the
 * threshold — but several times faster, because the matrix multiply underneath is built to
 * work on a batch and doing one point at a time wastes most of it.
 */
export function carriesPrintAll(
  image: RgbaImage,
  levels: Levels,
  points: readonly At[],
  spacing: number,
): boolean[] | null {
  if (!isGateTrained()) return null;

  const { net, space, patches } = model();
  const classes = net.classes.length;
  const verdicts: boolean[] = [];

  for (let from = 0; from < points.length; from += BATCH) {
    const count = Math.min(BATCH, points.length - from);
    for (let n = 0; n < count; n++) {
      const { cx, cy } = points[from + n];
      intersectionPatch(image, levels, cx, cy, spacing, patches, n * PATCH * PATCH);
    }

    // A short last chunk still runs a full batch: the workspace is sized for one, and the
    // rows past `count` are simply whatever the previous chunk left, which nothing reads.
    forward(net, patches, count, space);
    for (let n = 0; n < count; n++) {
      softmax(space.logits, n * classes, classes);
      const { index, probability } = best(space.logits, n * classes, classes);
      verdicts.push(net.classes[index] !== NOTHING && probability >= MIN_CONFIDENCE);
    }
  }

  return verdicts;
}

/** The patch a point would be judged on, for tools that want to look at what the gate sees. */
export function patchAt(
  image: RgbaImage,
  mask: BinaryImage,
  cx: number,
  cy: number,
  spacing: number,
): Float32Array {
  const patch = new Float32Array(PATCH * PATCH);
  intersectionPatch(image, imageLevels(image, mask), cx, cy, spacing, patch);
  return patch;
}

if (PATCH !== INPUT) {
  throw new Error(`the gate cuts ${PATCH}px patches but the net wants ${INPUT}px`);
}
