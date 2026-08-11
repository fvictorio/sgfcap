/**
 * Train the stone reader.
 *
 *   pnpm train-stones                      # 20 epochs over dataset/patches
 *   pnpm train-stones --epochs 40 --check  # verify the gradients first
 *
 * Writes `src/detect/stoneWeights.ts`. The question is the first one asked of every point on
 * the board: is there a stone here, and if so which colour?
 *
 * The rules this replaces answer it by looking for ink — a ring of it around a white stone, a
 * disc of it under a black one — and they answer it well on anything printed. What they
 * cannot do is answer it on a board that is not printed. A diagram rendered on wood has no
 * ink anywhere: its white stones are pale discs on a pale board, told apart by shading, and
 * they leave a ring of 0.04 where a printed white stone leaves 0.45 and up. Every threshold
 * in `stones.ts` is calibrated on ink and none of them reaches that.
 *
 * **No real page is ever trained on**, exactly as with the gate. Training is drawn diagrams;
 * the books outside the held-out sources choose which epoch to keep, and the held-out ones
 * are not looked at until the end. What makes that possible is that the generator now draws
 * the hard case — see `palette` in `diagrams.ts`.
 *
 * **Empty points are resampled every epoch.** Nineteen points in twenty are bare, and
 * training on that ratio straight teaches the model to say `empty` and be right. A few times
 * as many bare points as stones is enough to learn the boundary, and drawing a different
 * sample each epoch means it still meets nearly all of them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forward, INPUT, makeNet, makeWorkspace, softmax, TENSORS, type Net } from '../src/detect/net.js';
import { checkGradients, step, zerosLike } from './learn.js';

const DATA = fileURLToPath(new URL('../dataset/patches', import.meta.url));
const OUTPUT_DEFAULT = fileURLToPath(new URL('../src/detect/stoneWeights.ts', import.meta.url));
const PIXELS = INPUT * INPUT;

/** `empty` first, so index 0 is "nothing here". */
const CLASSES = ['empty', 'b', 'w'];

/** How many bare points to train against each stone. */
const EMPTY_RATIO = 2;

/** The confidence the reader runs at, so what is measured here is what will happen. */
const MIN_CONFIDENCE = 0.9;

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

const drawnStone: number[] = [];
const drawnEmpty: number[] = [];
const validation: number[] = [];
const test: number[] = [];
const labels = new Int32Array(rows.length);
const ruled = new Int32Array(rows.length);

rows.forEach((row, i) => {
  const parts = row.split('\t');
  const source = parts[1];
  const split = parts[2];
  const stone = parts[4];
  const said = parts[8];
  labels[i] = stone === 'empty' ? 0 : stone === 'b' ? 1 : 2;
  ruled[i] = said === 'empty' ? 0 : said === 'b' ? 1 : 2;
  if (source === 'generated') (labels[i] === 0 ? drawnEmpty : drawnStone).push(i);
  else if (split === 'held-out') test.push(i);
  else validation.push(i);
});

console.log(
  `drawn: ${drawnStone.length} stones, ${drawnEmpty.length} bare\n` +
    `books to choose the epoch: ${validation.length} points\n` +
    `books held back entirely:  ${test.length} points`,
);

/** What the hand-written rules get wrong on the same points, which is the bar. */
const ruleErrors = (indices: number[]) => indices.filter((i) => ruled[i] !== labels[i]).length;
console.log(
  `the rules today: ${ruleErrors(validation)} wrong of ${validation.length} chosen, ` +
    `${ruleErrors(test)} wrong of ${test.length} held back`,
);

let state = seed >>> 0;
const chance = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const net = makeNet(CLASSES, (size, fan) => {
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

/**
 * The eight ways a square can be laid down, applied at random as each batch is filled.
 *
 * A go board is the same board under every one of them — turn a diagram a quarter turn or
 * hold it to a mirror and it is still a legal position, drawn exactly as before. So each
 * patch is worth eight training examples rather than one, and that matters most for the class
 * there is least of: fourteen thousand stones against a hundred thousand bare points.
 *
 * Safe here in a way it would not be for reading the number printed on the stone, since a 6
 * held to a mirror is not a digit any book prints. This model is only ever asked whether a
 * stone is there and what colour it is, and a stone is a stone whichever way up its number is.
 */
function symmetry(x: number, y: number, how: number): number {
  const last = INPUT - 1;
  const sx = how & 4 ? y : x;
  const sy = how & 4 ? x : y;
  return (how & 2 ? last - sy : sy) * INPUT + (how & 1 ? last - sx : sx);
}

function fill(
  indices: number[],
  from: number,
  count: number,
  into: Float32Array,
  out: Int32Array,
  turn = false,
) {
  for (let n = 0; n < count; n++) {
    const i = indices[from + n];
    const at = i * PIXELS;
    const how = turn ? Math.floor(chance() * 8) : 0;
    for (let y = 0; y < INPUT; y++) {
      for (let x = 0; x < INPUT; x++) {
        into[n * PIXELS + y * INPUT + x] = (bytes[at + symmetry(x, y, how)] / 255) * 2 - 1;
      }
    }
    out[n] = labels[i];
  }
}

/** Points the model gets wrong at the running threshold, split by how bad the mistake is. */
function score(indices: number[]) {
  const one = makeWorkspace(1, CLASSES.length);
  const input = new Float32Array(PIXELS);
  let missed = 0;
  let invented = 0;
  let miscoloured = 0;

  for (const i of indices) {
    const at = i * PIXELS;
    for (let p = 0; p < PIXELS; p++) input[p] = (bytes[at + p] / 255) * 2 - 1;
    forward(net, input, 1, one);
    softmax(one.logits, 0, CLASSES.length);

    let best = 0;
    for (let c = 1; c < CLASSES.length; c++) if (one.logits[c] > one.logits[best]) best = c;
    const says = one.logits[best] >= MIN_CONFIDENCE ? best : 0;

    if (says === labels[i]) continue;
    if (labels[i] === 0) invented++;
    else if (says === 0) missed++;
    else miscoloured++;
  }

  return { missed, invented, miscoloured, total: missed + invented + miscoloured };
}

const grads = zerosLike(net);
const moment = zerosLike(net);
const velocity = zerosLike(net);
const input = new Float32Array(batch * PIXELS);
const truth = new Int32Array(batch);

let bestTotal = Infinity;
let bestWeights: Net | null = null;
let bestEpoch = -1;
let taken = 0;

for (let epoch = 0; epoch < epochs; epoch++) {
  for (let i = drawnEmpty.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [drawnEmpty[i], drawnEmpty[j]] = [drawnEmpty[j], drawnEmpty[i]];
  }
  const epochSet = [...drawnStone, ...drawnEmpty.slice(0, drawnStone.length * EMPTY_RATIO)];
  for (let i = epochSet.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [epochSet[i], epochSet[j]] = [epochSet[j], epochSet[i]];
  }

  const lr = rate * 0.5 * (1 + Math.cos((Math.PI * epoch) / Math.max(1, epochs - 1)));
  let loss = 0;
  let batches = 0;

  for (let at = 0; at + batch <= epochSet.length; at += batch) {
    for (const name of TENSORS) {
      grads.weights[name].fill(0);
      grads.biases[name].fill(0);
    }
    fill(epochSet, at, batch, input, truth, true);
    loss += step(net, space, input, truth, batch, grads, weight) / batch;
    batches++;
    taken++;

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
      `books: missed ${String(chosen.missed).padStart(3)}  invented ${String(chosen.invented).padStart(3)}  ` +
      `wrong colour ${String(chosen.miscoloured).padStart(3)}` +
      (chosen.total < bestTotal ? '   <- best so far' : ''),
  );

  if (chosen.total < bestTotal) {
    bestTotal = chosen.total;
    bestEpoch = epoch + 1;
    bestWeights = {
      classes: CLASSES,
      weights: Object.fromEntries(TENSORS.map((n) => [n, Float32Array.from(net.weights[n])])) as Net['weights'],
      biases: Object.fromEntries(TENSORS.map((n) => [n, Float32Array.from(net.biases[n])])) as Net['biases'],
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
    `  books that chose it:  ${chosen.total} wrong of ${validation.length}  (the rules: ${ruleErrors(validation)})\n` +
    `  books held back:      ${held.total} wrong of ${test.length}  (the rules: ${ruleErrors(test)})\n` +
    `    missed ${held.missed}, invented ${held.invented}, wrong colour ${held.miscoloured}`,
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
 * Weights for the stone reader in \`stoneNet.ts\`.
 *
 * Generated by \`pnpm train-stones\` — do not edit by hand. Stored as int8 with one scale per
 * tensor, base64 encoded.
 *
 * Trained on ${drawnStone.length} stones and the bare points around them, all of them drawn by
 * \`pnpm patches\`. Kept at the epoch that read ${validation.length} points from the books best,
 * and reported against ${test.length} more from sources held out of everything. No point on a
 * real page is ever trained on.
 */
export interface QuantisedTensor {
  scale: number;
  data: string;
}

export const STONE_CLASSES: string[] = ${JSON.stringify(CLASSES)};

export const STONE_WEIGHTS: Record<string, QuantisedTensor> = {
${tensors.join('\n')}
};
`,
);

console.log(`  -> ${OUTPUT}`);
