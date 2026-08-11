/**
 * Train the glyph classifier.
 *
 *   pnpm train                      # 20 epochs over dataset/
 *   pnpm train --epochs 40 --check  # verify the gradients first
 *
 * Writes `src/detect/weights.ts`, a generated file checked in beside `exemplars.ts` and for
 * the same reason: the browser gets a model without a runtime to load it.
 *
 * **Trained on drawn diagrams, validated on books.** The books are 1.5% of the samples and
 * the only real evidence there is, so spending them on training would buy a fraction of a
 * percent and cost the one number that predicts whether the next scan works.
 *
 * The gradients live in `learn.ts`, shared with the gate trainer. `--check` compares every
 * one of them against a finite difference before a long run: a subtly wrong gradient does
 * not crash, it trains to something mediocre and leaves you wondering about the
 * architecture.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forward,
  INPUT,
  makeNet,
  makeWorkspace,
  softmax,
  TENSORS,
  type Net,
} from '../src/detect/net.js';
import { checkGradients, step, zerosLike, type Gradients } from './learn.js';

const DATA = fileURLToPath(new URL('../dataset', import.meta.url));
const OUTPUT_DEFAULT = fileURLToPath(new URL('../src/detect/weights.ts', import.meta.url));
const PIXELS = INPUT * INPUT;

// ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};

const at = process.argv.indexOf('--out');
const OUTPUT = at === -1 ? OUTPUT_DEFAULT : process.argv[at + 1];

const epochs = flag('epochs', 20);
const batch = flag('batch', 64);
const rate = flag('rate', 0.002);

/**
 * Which random draw to take, for the weights' starting point and the order of the batches.
 *
 * Fixed by default so a rebuild reproduces, and settable so that several runs can be compared
 * without changing anything else about them. Without it every run at the same settings is
 * byte-identical, which is reproducible and useless for telling a real improvement from a
 * lucky one.
 */
const chosenSeed = flag('seed', 12345);

const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8')) as {
  size: number;
  samples: number;
  classes: string[];
};
if (meta.size !== INPUT) throw new Error(`dataset is ${meta.size}px, the net wants ${INPUT}`);

const pixels = new Uint8Array(readFileSync(join(DATA, 'glyphs.bin')));
const rows = readFileSync(join(DATA, 'glyphs.tsv'), 'utf8').trim().split('\n').slice(1);
const classIndex = new Map(meta.classes.map((c, i) => [c, i]));

/**
 * The books are split in two, by diagram.
 *
 * One half chooses which epoch's weights to keep, the other is never consulted until the
 * end. Choosing a checkpoint by a score is a way of fitting to that score, so a number used
 * for choosing cannot also be the number reported — it would be optimistic by however many
 * epochs were tried. Splitting by diagram rather than by sample keeps glyphs from the same
 * scan on the same side.
 */
const drawn: number[] = [];
const validation: number[] = [];
const test: number[] = [];
const labels = new Int32Array(rows.length);

const sideOf = (source: string) => {
  let hash = 0;
  for (const c of source) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? validation : test;
};

rows.forEach((row, i) => {
  const [label, source] = row.split('\t');
  labels[i] = classIndex.get(label) ?? -1;
  if (source.startsWith('drawn/')) drawn.push(i);
  else sideOf(source).push(i);
});

console.log(
  `${drawn.length} drawn samples to train on; ` +
    `${validation.length} book samples to choose the epoch, ${test.length} held back entirely`,
);

// Loss weights, so the rarest class is not simply ignored. The square root rather than the
// reciprocal: full inverse-frequency weighting makes a handful of rare samples dominate.
const counts = new Float64Array(meta.classes.length);
for (const i of drawn) counts[labels[i]]++;
const mean = counts.reduce((t, v) => t + v, 0) / counts.length;
const weight = new Float32Array(meta.classes.length);
for (let c = 0; c < weight.length; c++) {
  weight[c] = counts[c] === 0 ? 0 : Math.sqrt(mean / counts[c]);
}

let seed = chosenSeed;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// He initialisation: a normal scaled by the fan-in, which is what keeps the signal from
// dying or exploding through three ReLU layers.
const gaussian = () => {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};
const net = makeNet(meta.classes, (size, fan) => {
  const scale = Math.sqrt(2 / fan);
  return new Float32Array(size).map(() => gaussian() * scale);
});

const space = makeWorkspace(batch, meta.classes.length);

if (args.includes('--check')) {
  console.log('checking gradients against finite differences');
  checkGradients(net, makeWorkspace(4, meta.classes.length), weight);
}

/** Fill a batch, shifting each glyph by a pixel or so — segmentation is never exact. */
/**
 * Thicken or thin a glyph by a pixel, which is the axis printing varies on most.
 *
 * A book set light and the same book set heavy are different pictures to a detector, and the
 * corpus contains both — as well as scans that have thickened everything and photocopies that
 * have eaten strokes away. The drawn set covers weight through the typefaces it renders in,
 * but only at the weights those faces happen to offer, and a stroke either side of that is
 * free to add and entirely label-preserving: a fatter 1 is still a 1.
 *
 * Max over the neighbourhood thickens, min thins, which is dilation and erosion under their
 * usual names.
 */
function reweight(patch: Float32Array, at: number, thicken: boolean): void {
  const copy = patch.slice(at, at + PIXELS);
  for (let y = 0; y < INPUT; y++) {
    for (let x = 0; x < INPUT; x++) {
      let value = copy[y * INPUT + x];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sy = y + dy;
          const sx = x + dx;
          // Off the edge counts as background, so a stroke against the rim thins from it too.
          const near = sy < 0 || sx < 0 || sy >= INPUT || sx >= INPUT ? 0 : copy[sy * INPUT + sx];
          value = thicken ? Math.max(value, near) : Math.min(value, near);
        }
      }
      patch[at + y * INPUT + x] = value;
    }
  }
}

function fill(indices: number[], from: number, count: number, into: Float32Array, out: Int32Array, jitter: boolean): void {
  into.fill(0);
  for (let n = 0; n < count; n++) {
    const sample = indices[from + n];
    out[n] = labels[sample];
    const dx = jitter ? Math.round(random() * 2 - 1) : 0;
    const dy = jitter ? Math.round(random() * 2 - 1) : 0;
    const source = sample * PIXELS;
    const target = n * PIXELS;

    for (let y = 0; y < INPUT; y++) {
      const sy = y + dy;
      if (sy < 0 || sy >= INPUT) continue;
      for (let x = 0; x < INPUT; x++) {
        const sx = x + dx;
        if (sx < 0 || sx >= INPUT) continue;
        into[target + y * INPUT + x] = pixels[source + sy * INPUT + sx] / 255;
      }
    }

    // A third of the batch is redrawn a stroke heavier or lighter — see `reweight`.
    if (jitter) {
      const roll = random();
      if (roll < 0.17) reweight(into, target, true);
      else if (roll < 0.34) reweight(into, target, false);
    }
  }
}

function accuracy(indices: number[]): number {
  const input = new Float32Array(batch * PIXELS);
  const truth = new Int32Array(batch);
  let right = 0;

  for (let at = 0; at + batch <= indices.length; at += batch) {
    fill(indices, at, batch, input, truth, false);
    forward(net, input, batch, space);
    for (let n = 0; n < batch; n++) {
      let top = 0;
      for (let c = 1; c < meta.classes.length; c++) {
        if (space.logits[n * meta.classes.length + c] > space.logits[n * meta.classes.length + top]) top = c;
      }
      if (top === truth[n]) right++;
    }
  }

  return right / (Math.floor(indices.length / batch) * batch);
}

// Adam, which is forgiving about the learning rate in a way plain SGD is not.
const moment1 = zerosLike(net);
const moment2 = zerosLike(net);
let iteration = 0;

// The best weights seen, not the last. Accuracy on the books peaks early and then drifts
// down while accuracy on the drawn diagrams keeps climbing — the model getting better at
// synthetic glyphs and worse at printed ones. Measured: the twenty-fourth epoch read 86%
// of a real diagram where the third read 90%.
let bestScore = -1;
const bestWeights = zerosLike(net);
let bestEpoch = 0;

const keep = () => {
  for (const name of TENSORS) {
    bestWeights.weights[name].set(net.weights[name]);
    bestWeights.biases[name].set(net.biases[name]);
  }
};

const input = new Float32Array(batch * PIXELS);
const truth = new Int32Array(batch);
const grads = zerosLike(net);

for (let epoch = 1; epoch <= epochs; epoch++) {
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j], drawn[i]];
  }

  const started = Date.now();
  let total = 0;
  let steps = 0;

  // Cosine decay. The late epochs bounced between 91% and 95% on the books, which is a
  // learning rate that never came down: large steps keep knocking the weights off whatever
  // they had settled into.
  const learningRate = rate * 0.5 * (1 + Math.cos((Math.PI * (epoch - 1)) / epochs));

  for (let at = 0; at + batch <= drawn.length; at += batch) {
    for (const name of TENSORS) {
      grads.weights[name].fill(0);
      grads.biases[name].fill(0);
    }

    fill(drawn, at, batch, input, truth, true);
    total += step(net, space, input, truth, batch, grads, weight) / batch;
    steps++;
    iteration++;

    const correction1 = 1 - Math.pow(0.9, iteration);
    const correction2 = 1 - Math.pow(0.999, iteration);

    for (const name of TENSORS) {
      for (const [values, g, m1, m2] of [
        [net.weights[name], grads.weights[name], moment1.weights[name], moment2.weights[name]],
        [net.biases[name], grads.biases[name], moment1.biases[name], moment2.biases[name]],
      ] as const) {
        for (let i = 0; i < values.length; i++) {
          const gradient = g[i] / batch;
          m1[i] = 0.9 * m1[i] + 0.1 * gradient;
          m2[i] = 0.999 * m2[i] + 0.001 * gradient * gradient;
          values[i] -= (learningRate * (m1[i] / correction1)) / (Math.sqrt(m2[i] / correction2) + 1e-8);
        }
      }
    }
  }

  const seconds = (Date.now() - started) / 1000;
  const score = accuracy(validation);
  if (score > bestScore) {
    bestScore = score;
    bestEpoch = epoch;
    keep();
  }

  console.log(
    `epoch ${String(epoch).padStart(2)}  loss ${(total / steps).toFixed(4)}  ` +
      `drawn ${(accuracy(drawn.slice(0, 4096)) * 100).toFixed(1)}%  ` +
      `validation ${(score * 100).toFixed(1)}%${score === bestScore ? ' *' : '  '}  ` +
      `${seconds.toFixed(0)}s`,
  );
}

for (const name of TENSORS) {
  net.weights[name].set(bestWeights.weights[name]);
  net.biases[name].set(bestWeights.biases[name]);
}
console.log(`\nkeeping epoch ${bestEpoch}: validation ${(bestScore * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------------------

/**
 * Written out as int8 with one scale per tensor.
 *
 * Float32 would be 420KB of base64 in a bundle that is currently 180KB all in. Quantising
 * symmetrically to a byte costs a quarter of a percent on the books here and takes it to
 * about 105KB.
 */
function quantise(values: Float32Array): { scale: number; bytes: string } {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));

  const scale = peak / 127 || 1;
  const bytes = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(values[i] / scale))) & 0xff;
  }

  return { scale, bytes: bytes.toString('base64') };
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
 * Weights for the glyph classifier in \`net.ts\`.
 *
 * Generated by \`pnpm train\` — do not edit by hand. Stored as int8 with one scale per
 * tensor, base64 encoded, which is a quarter the size of float32 for a fraction of a
 * percent of accuracy.
 *
 * Trained on ${drawn.length} glyphs drawn by \`pnpm dataset\`, kept at the epoch that read
 * ${validation.length} book glyphs best, and reported against ${test.length} more that were
 * never used for training or for choosing. No book glyph is ever trained on.
 */
export interface QuantisedTensor {
  scale: number;
  data: string;
}

export const CLASSES: string[] = ${JSON.stringify(meta.classes)};

export const WEIGHTS: Record<string, QuantisedTensor> = {
${tensors.join('\n')}
};
`,
);

console.log(
  `held back and never used for anything: ${(accuracy(test) * 100).toFixed(1)}%  ->  ${OUTPUT}`,
);
