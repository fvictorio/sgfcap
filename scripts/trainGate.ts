/**
 * Train the print gate.
 *
 *   pnpm train-gate                      # 20 epochs over dataset/patches
 *   pnpm train-gate --epochs 40 --check  # verify the gradients first
 *
 * Writes `src/detect/gateWeights.ts`. The question is the one in `gate.ts`: at a point with
 * no stone on it, is anything printed here, or is this a bare crossing?
 *
 * **No real page is ever trained on.** Training is drawn diagrams only; the books are used
 * twice and never for learning — the ones outside the held-out sources choose which epoch to
 * keep, and the held-out ones are not looked at until the end. That is the same bargain
 * `pnpm train` strikes, and here it is not really a choice: fifty-four books carry forty-four
 * reference letters between them, which is enough to find out whether something works and
 * nowhere near enough to teach it.
 *
 * It also answers the question that matters about a learned gate. A model trained on the
 * corpus and scored on the corpus would tell us nothing about the next book; this one has
 * never seen a book at all, so what it scores on the held-out sources is what it knows about
 * printing rather than what it memorised about these pages.
 *
 * **Negatives are resampled every epoch.** Bare points outnumber printed ones about thirty to
 * one, and training on that ratio straight teaches the model to say `none` and be right. A
 * few times as many negatives as positives is enough to learn the boundary, and drawing a
 * different sample each epoch means it still meets nearly all of them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forward, INPUT, makeNet, makeWorkspace, softmax, TENSORS, type Net } from '../src/detect/net.js';
import { checkGradients, step, zerosLike } from './learn.js';

const DATA = fileURLToPath(new URL('../dataset/patches', import.meta.url));
const OUTPUT_DEFAULT = fileURLToPath(new URL('../src/detect/gateWeights.ts', import.meta.url));
const PIXELS = INPUT * INPUT;

/** The two answers. `none` first, so index 0 is "nothing printed here". */
const CLASSES = ['none', 'letter'];

/** How many bare points to train against each printed one. */
const NEGATIVE_RATIO = 4;

/**
 * What the gate is scored on while choosing an epoch.
 *
 * An invented label costs twice a missed one. Both are wrong, but they are not equally wrong:
 * a letter the gate misses is one claim short, while a letter it invents puts a mark on the
 * board that was never on the page, and whoever reads the diagram afterwards has to know to
 * delete it. Choosing on plain accuracy would trade three of the second for two of the first
 * and call it progress.
 */
const INVENTED_COSTS = 2;

/** The confidence the gate runs at, so what is measured here is what will happen. */
const MIN_CONFIDENCE = 0.8;

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const outAt = args.indexOf('--out');
const OUTPUT = outAt === -1 ? OUTPUT_DEFAULT : args[outAt + 1];

const epochs = flag('epochs', 20);
const batch = flag('batch', 64);
const rate = flag('rate', 0.002);
const seed = flag('seed', 1);

const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8')) as { size: number };
if (meta.size !== INPUT) throw new Error(`patches are ${meta.size}px, the net wants ${INPUT}`);

const bytes = new Uint8Array(readFileSync(join(DATA, 'patches.bin')));
const rows = readFileSync(join(DATA, 'patches.tsv'), 'utf8').trim().split('\n').slice(1);

/**
 * Only points with no stone on them, because that is the only place the gate is ever asked.
 * A number printed on a stone reaches the reader by a different route and never comes past
 * here, so training against those would be learning to answer a question nobody asks.
 */
const drawnPositive: number[] = [];
const drawnNegative: number[] = [];
const validation: number[] = [];
const test: number[] = [];
const labels = new Int32Array(rows.length);

rows.forEach((row, i) => {
  const [, source, split, , stone, content] = row.split('\t');
  if (stone !== 'empty') return;

  labels[i] = content === 'none' ? 0 : 1;
  if (source === 'generated') (labels[i] === 1 ? drawnPositive : drawnNegative).push(i);
  else if (split === 'held-out') test.push(i);
  else validation.push(i);
});

const printed = (indices: number[]) => indices.filter((i) => labels[i] === 1).length;

console.log(
  `drawn: ${drawnPositive.length} printed, ${drawnNegative.length} bare\n` +
    `books to choose the epoch: ${validation.length} points, ${printed(validation)} printed\n` +
    `books held back entirely:  ${test.length} points, ${printed(test)} printed`,
);
if (drawnPositive.length === 0) {
  throw new Error('no drawn letters in the set — run `pnpm patches` with --count above zero');
}

let state = seed >>> 0;
const chance = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const net = makeNet(CLASSES, (size, fan) => {
  // He initialisation: normal, scaled by the fan-in, which is what ReLU wants.
  const values = new Float32Array(size);
  const deviation = Math.sqrt(2 / fan);
  for (let i = 0; i < size; i++) {
    const u = Math.max(1e-9, chance());
    values[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * chance()) * deviation;
  }
  return values;
});

const space = makeWorkspace(batch, CLASSES.length);
const weight = new Float32Array(CLASSES.length).fill(1);

if (args.includes('--check')) {
  console.log('\nchecking gradients against finite differences');
  checkGradients(net, makeWorkspace(4, CLASSES.length), weight);
}

/** Fill a batch from `indices`, dequantising the bytes back to the range the patch was cut in. */
function fill(indices: number[], from: number, count: number, into: Float32Array, out: Int32Array) {
  for (let n = 0; n < count; n++) {
    const i = indices[from + n];
    const at = i * PIXELS;
    for (let p = 0; p < PIXELS; p++) into[n * PIXELS + p] = (bytes[at + p] / 255) * 2 - 1;
    out[n] = labels[i];
  }
}

/** Bare points called printed, and printed points called bare, at the running threshold. */
function score(indices: number[]): { invented: number; missed: number; cost: number } {
  const one = makeWorkspace(1, CLASSES.length);
  const input = new Float32Array(PIXELS);
  let invented = 0;
  let missed = 0;

  for (const i of indices) {
    const at = i * PIXELS;
    for (let p = 0; p < PIXELS; p++) input[p] = (bytes[at + p] / 255) * 2 - 1;
    forward(net, input, 1, one);
    softmax(one.logits, 0, CLASSES.length);

    const says = one.logits[1] >= MIN_CONFIDENCE ? 1 : 0;
    if (says === 1 && labels[i] === 0) invented++;
    if (says === 0 && labels[i] === 1) missed++;
  }

  return { invented, missed, cost: invented * INVENTED_COSTS + missed };
}

const grads = zerosLike(net);
const moment = zerosLike(net);
const velocity = zerosLike(net);
const input = new Float32Array(batch * PIXELS);
const truth = new Int32Array(batch);

let bestCost = Infinity;
let bestWeights: Net | null = null;
let bestEpoch = -1;
let taken = 0;

for (let epoch = 0; epoch < epochs; epoch++) {
  // A fresh sample of bare points, so across the run the model meets most of them.
  for (let i = drawnNegative.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [drawnNegative[i], drawnNegative[j]] = [drawnNegative[j], drawnNegative[i]];
  }
  const epochSet = [
    ...drawnPositive,
    ...drawnNegative.slice(0, drawnPositive.length * NEGATIVE_RATIO),
  ];
  for (let i = epochSet.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [epochSet[i], epochSet[j]] = [epochSet[j], epochSet[i]];
  }

  // Cosine decay, as in `pnpm train`: the late epochs otherwise bounce around the optimum.
  const lr = rate * 0.5 * (1 + Math.cos((Math.PI * epoch) / Math.max(1, epochs - 1)));
  let loss = 0;
  let batches = 0;

  for (let at = 0; at + batch <= epochSet.length; at += batch) {
    for (const name of TENSORS) {
      grads.weights[name].fill(0);
      grads.biases[name].fill(0);
    }
    fill(epochSet, at, batch, input, truth);
    loss += step(net, space, input, truth, batch, grads, weight) / batch;
    batches++;
    taken++;

    // Adam.
    for (const name of TENSORS) {
      for (const [values, g, m, v] of [
        [net.weights[name], grads.weights[name], moment.weights[name], velocity.weights[name]],
        [net.biases[name], grads.biases[name], moment.biases[name], velocity.biases[name]],
      ] as const) {
        for (let i = 0; i < values.length; i++) {
          const gradient = g[i] / batch;
          m[i] = 0.9 * m[i] + 0.1 * gradient;
          v[i] = 0.999 * v[i] + 0.001 * gradient * gradient;
          const mh = m[i] / (1 - Math.pow(0.9, taken));
          const vh = v[i] / (1 - Math.pow(0.999, taken));
          values[i] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
        }
      }
    }
  }

  const chosen = score(validation);
  console.log(
    `epoch ${String(epoch + 1).padStart(2)}  loss ${(loss / batches).toFixed(4)}  ` +
      `books: invented ${String(chosen.invented).padStart(3)}  missed ${String(chosen.missed).padStart(2)}` +
      (chosen.cost < bestCost ? '   <- best so far' : ''),
  );

  if (chosen.cost < bestCost) {
    bestCost = chosen.cost;
    bestEpoch = epoch + 1;
    bestWeights = {
      classes: CLASSES,
      weights: Object.fromEntries(
        TENSORS.map((n) => [n, Float32Array.from(net.weights[n])]),
      ) as Net['weights'],
      biases: Object.fromEntries(
        TENSORS.map((n) => [n, Float32Array.from(net.biases[n])]),
      ) as Net['biases'],
    };
  }
}

if (!bestWeights) throw new Error('no epoch completed');
Object.assign(net.weights, bestWeights.weights);
Object.assign(net.biases, bestWeights.biases);

const chosen = score(validation);
const held = score(test);
console.log(
  `\nkept epoch ${bestEpoch}\n` +
    `  books that chose it:  invented ${chosen.invented} of ${validation.length - printed(validation)} bare,  ` +
    `missed ${chosen.missed} of ${printed(validation)} printed\n` +
    `  books held back:      invented ${held.invented} of ${test.length - printed(test)} bare,  ` +
    `missed ${held.missed} of ${printed(test)} printed`,
);

function quantise(values: Float32Array): { scale: number; bytes: string } {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));

  const scale = peak / 127 || 1;
  const buffer = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    buffer[i] = Math.max(-127, Math.min(127, Math.round(values[i] / scale))) & 0xff;
  }

  return { scale, bytes: buffer.toString('base64') };
}

const tensors = TENSORS.flatMap((name) => {
  const w = quantise(net.weights[name]);
  const b = quantise(net.biases[name]);
  return [
    `  ${name}: { scale: ${w.scale}, data: '${w.bytes}' },`,
    `  ${name}Bias: { scale: ${b.scale}, data: '${b.bytes}' },`,
  ];
});

writeFileSync(
  OUTPUT,
  `/**
 * Weights for the print gate in \`gate.ts\`.
 *
 * Generated by \`pnpm train-gate\` — do not edit by hand. Stored as int8 with one scale per
 * tensor, base64 encoded, which is a quarter the size of float32.
 *
 * Trained on ${drawnPositive.length} printed and ${drawnPositive.length * NEGATIVE_RATIO} bare
 * points, all of them drawn by \`pnpm patches\`. Kept at the epoch that read ${validation.length}
 * points from the books best, and reported against ${test.length} more from sources held out of
 * everything. No point on a real page is ever trained on.
 */
export interface QuantisedTensor {
  scale: number;
  data: string;
}

export const GATE_CLASSES: string[] = ${JSON.stringify(CLASSES)};

export const GATE_WEIGHTS: Record<string, QuantisedTensor> = {
${tensors.join('\n')}
};
`,
);

console.log(`  -> ${OUTPUT}`);
