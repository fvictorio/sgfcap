/**
 * What is standing on each point, read from the picture rather than from a threshold.
 *
 * The rules in `stones.ts` decide this by looking for ink: a ring of it around a white stone,
 * a disc of it under a black one. That works on anything printed and cannot work on anything
 * else. A board rendered or photographed on wood has no ink at all — its white stones are
 * pale discs on a pale board, told apart by shading — and every threshold there is calibrated
 * against a quantity that is simply absent.
 *
 * This reads the same patch the gate does: greyscale, scaled by the line spacing, with the
 * page's own ink and paper levels mapped to fixed numbers. Deliberately not a mask, for
 * exactly the reason above.
 */
import { best, forward, INPUT, makeWorkspace, softmax, TENSORS, type Net, type TensorName, type Workspace } from './net.js';
import { STONE_CLASSES, STONE_WEIGHTS, type QuantisedTensor } from './stoneWeights.js';
import { intersectionPatch, PATCH, type Levels } from './patch.js';
import type { RgbaImage, StoneColor } from '../types.js';
import type { At } from './gate.js';

/**
 * How sure the reader has to be before its answer is used at all.
 *
 * A stone in the wrong place is not one claim among many, it is the position being wrong, so
 * the safe failure is to say nothing and let the rules answer instead.
 */
const MIN_CONFIDENCE = 0.9;

/** The class meaning no stone. */
const NOTHING = 'empty';

/** Points judged in one pass. Bounded because the feature maps, not the patches, cost memory. */
const BATCH = 64;

function dequantise(tensor: QuantisedTensor): Float32Array {
  const bytes =
    typeof atob === 'function'
      ? Uint8Array.from(atob(tensor.data), (c) => c.charCodeAt(0))
      : new Uint8Array(Buffer.from(tensor.data, 'base64'));

  const values = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) values[i] = ((bytes[i] << 24) >> 24) * tensor.scale;

  return values;
}

let loaded: { net: Net; space: Workspace; patches: Float32Array } | null = null;

function model() {
  if (loaded) return loaded;

  const weights = {} as Record<TensorName, Float32Array>;
  const biases = {} as Record<TensorName, Float32Array>;
  for (const name of TENSORS) {
    weights[name] = dequantise(STONE_WEIGHTS[name]);
    biases[name] = dequantise(STONE_WEIGHTS[`${name}Bias`]);
  }

  loaded = {
    net: { classes: STONE_CLASSES, weights, biases },
    space: makeWorkspace(BATCH, STONE_CLASSES.length),
    patches: new Float32Array(BATCH * PATCH * PATCH),
  };

  return loaded;
}

/** Whether a model has been trained — `stoneWeights.ts` is empty until `pnpm train-stones` runs. */
export function isStoneNetTrained(): boolean {
  return STONE_CLASSES.length > 0;
}

/** What the model says stands on a point: a colour, nothing, or that it would rather not say. */
export type Verdict = StoneColor | 'empty' | 'unsure';

/**
 * What the model says stands on each point, or null where none has been trained.
 *
 * `unsure` is kept apart from `empty` deliberately. Those are different answers and the
 * caller does different things with them: a confident `empty` is worth believing, while
 * `unsure` means the rules should have the last word.
 */
export function readStones(
  image: RgbaImage,
  levels: Levels,
  points: readonly At[],
  spacing: number,
): Verdict[] | null {
  if (!isStoneNetTrained()) return null;

  const { net, space, patches } = model();
  const classes = net.classes.length;
  const out: Verdict[] = [];

  for (let from = 0; from < points.length; from += BATCH) {
    const count = Math.min(BATCH, points.length - from);
    for (let n = 0; n < count; n++) {
      const { cx, cy } = points[from + n];
      intersectionPatch(image, levels, cx, cy, spacing, patches, n * PATCH * PATCH);
    }

    forward(net, patches, count, space);
    for (let n = 0; n < count; n++) {
      softmax(space.logits, n * classes, classes);
      const { index, probability } = best(space.logits, n * classes, classes);
      const label = net.classes[index];
      out.push(probability < MIN_CONFIDENCE ? 'unsure' : label === NOTHING ? 'empty' : (label as StoneColor));
    }
  }

  return out;
}
