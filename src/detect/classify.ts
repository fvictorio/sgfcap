/**
 * Reading a glyph: one goes in, a character or nothing comes out.
 *
 * This replaced a nearest-neighbour matcher that scored each glyph against prototypes cut
 * from the fixtures. That approach has a ceiling built into it — a character no fixture
 * happened to print was one it could never learn, which cost it capital letters and every
 * mark but the triangle — and it was finally behind on the corpus as well as in principle.
 *
 * Two things this does that the matcher could not.
 *
 * **It can say `nothing`.** A quarter of what it was trained on is board corners, line
 * crossings, star points, plain stones and two-digit numbers fused into one shape. Asking
 * "which character is this closest to" needs a threshold and a pile of hand-written guards
 * to turn into "is this a character at all"; here it is a class.
 *
 * **It is told what to expect.** A number is printed on a stone and a letter on a bare
 * point, and the reader knows which it is looking at, so the scores of the classes that
 * cannot occur are simply not considered. That removes the confusions that survive any
 * amount of training — 0 against O, 1 against l, 5 against S.
 */
import {
  best,
  forward,
  INPUT,
  makeWorkspace,
  softmax,
  TENSORS,
  toInput,
  type Net,
  type TensorName,
  type Workspace,
} from './net.js';
import { CLASSES, WEIGHTS, type QuantisedTensor } from './weights.js';

/**
 * How sure the classifier has to be before its answer is used.
 *
 * Below this the glyph is read as nothing, which is the safe failure: a stone left
 * unnumbered is a stone the reader got wrong, but a stone given the wrong number renumbers
 * everything after it.
 */
const MIN_CONFIDENCE = 0.5;

/**
 * How much of the model's belief has to fall on answers that are possible here at all.
 *
 * Sharing the scores out again over what is allowed is right where the true answer is one of
 * them and merely lost to a look-alike that is not — a `1` beaten by an `l`. It is quite
 * wrong where the true answer is not in the set: the model puts 0.99 on `2`, that class is
 * struck out for not being a mark, and the thousandths left scattered over triangle, square
 * and circle get scaled up into a confident triangle. Nine generated diagrams read a move
 * number as a mark exactly that way.
 *
 * So the total before sharing out is looked at first. It is the model's answer to a question
 * worth asking on its own — how much do you believe it is any of these things — and when
 * that is nearly nothing, the honest reading is none of them, whatever the shares say.
 */
const MIN_POSSIBLE = 0.05;

export type GlyphKind = 'digit' | 'letter' | 'mark';

const MEMBERS: Record<GlyphKind, RegExp> = {
  digit: /^[0-9]$/,
  letter: /^[A-Za-z]$/,
  mark: /^(triangle|square|circle|cross)$/,
};

/** int8 back to floats. One scale per tensor, which is all the precision a byte affords. */
function dequantise(tensor: QuantisedTensor): Float32Array {
  const bytes =
    typeof atob === 'function'
      ? Uint8Array.from(atob(tensor.data), (c) => c.charCodeAt(0))
      : new Uint8Array(Buffer.from(tensor.data, 'base64'));

  const values = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    // Stored as two's complement in a byte, so anything above 127 is negative.
    values[i] = ((bytes[i] << 24) >> 24) * tensor.scale;
  }

  return values;
}

let loaded: { net: Net; space: Workspace; input: Float32Array } | null = null;

/** Built once, on the first glyph read rather than at import, so a page that never converts pays nothing. */
function model() {
  if (loaded) return loaded;

  const weights = {} as Record<TensorName, Float32Array>;
  const biases = {} as Record<TensorName, Float32Array>;
  for (const name of TENSORS) {
    weights[name] = dequantise(WEIGHTS[name]);
    biases[name] = dequantise(WEIGHTS[`${name}Bias`]);
  }

  loaded = {
    net: { classes: CLASSES, weights, biases },
    space: makeWorkspace(1, CLASSES.length),
    input: new Float32Array(INPUT * INPUT),
  };

  return loaded;
}

/** Whether a model has been trained yet — `weights.ts` is empty until `pnpm train` runs. */
export function isTrained(): boolean {
  return CLASSES.length > 0;
}

/**
 * Read one glyph as a character of the given kind, or null.
 *
 * `allowed` narrows it further where the caller knows more — a diagram that letters its
 * points a, b, c is not about to print a q.
 */
/**
 * Every character of this kind the glyph might be, best first, with the model's probability.
 *
 * The same masking and sharing out that `classify` does, without the threshold and without
 * committing to one answer — for the sequence decoder, which can weigh these against each
 * other across a whole diagram. `nothing` is left out: it is not a reading.
 */
export function rank(
  glyph: { width: number; height: number; pixels: Uint8Array },
  kind: GlyphKind,
): Array<{ label: string; score: number }> {
  if (!isTrained()) return [];

  const { net, space, input } = model();
  toInput(glyph, input);
  forward(net, input, 1, space);
  softmax(space.logits, 0, net.classes.length);

  let live = 0;
  for (let c = 0; c < net.classes.length; c++) {
    const label = net.classes[c];
    if (label !== 'nothing' && !MEMBERS[kind].test(label)) space.logits[c] = 0;
    live += space.logits[c];
  }
  if (live <= 0) return [];

  const ranked: Array<{ label: string; score: number }> = [];
  for (let c = 0; c < net.classes.length; c++) {
    const label = net.classes[c];
    if (label === 'nothing' || space.logits[c] === 0) continue;
    ranked.push({ label, score: space.logits[c] / live });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

export function classify(
  glyph: { width: number; height: number; pixels: Uint8Array },
  kind: GlyphKind,
  allowed?: ReadonlySet<string>,
): { label: string; confidence: number } | null {
  if (!isTrained()) return null;

  const { net, space, input } = model();
  toInput(glyph, input);
  forward(net, input, 1, space);
  softmax(space.logits, 0, net.classes.length);

  // Everything the context rules out scores zero, so the winner is the best of what could
  // actually be printed here. `nothing` always stays in — it is the answer that matters.
  let live = 0;
  for (let c = 0; c < net.classes.length; c++) {
    const label = net.classes[c];
    if (label !== 'nothing' && (!MEMBERS[kind].test(label) || (allowed && !allowed.has(label)))) {
      space.logits[c] = 0;
    }
    live += space.logits[c];
  }

  // Share out again over what is left, so the confidence means what the threshold below
  // takes it to mean: how sure the model is *among the answers that are possible here*.
  //
  // Without this, ruling a class out takes its score off the board and leaves it nowhere —
  // and since the classes ruled out are precisely the ones that look like the answer, the
  // right answer is left holding whatever it could win against a competitor that cannot
  // occur. A number printed on a stone is read against the whole alphabet, so `1` loses to
  // `l` and `0` to `o` and `9` to `g`; strike the letter out and the digit is still sitting
  // at a quarter, under the threshold, and a stone that plainly reads 17 comes back
  // unnumbered. Twenty of the twenty-five numbers missed across the corpus were this.
  // Nothing possible got any real weight: this is not one of the things being asked about.
  if (live < MIN_POSSIBLE) return null;
  for (let c = 0; c < net.classes.length; c++) space.logits[c] /= live;

  const { index, probability } = best(space.logits, 0, net.classes.length);
  const label = net.classes[index];
  if (label === 'nothing' || probability < MIN_CONFIDENCE) return null;

  return { label, confidence: probability };
}
