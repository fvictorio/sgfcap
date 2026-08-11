/**
 * A small convolutional classifier for the characters printed on a diagram.
 *
 * The forward pass only — training lives in `scripts/train.ts`, which imports this so that
 * what is trained is exactly what runs in the browser. That is not tidiness: a model that
 * scores well in training and reads differently in the app, because the two implementations
 * of a convolution disagree about padding or channel order, is a genuinely nasty bug and
 * the usual way to get it is to write the two separately.
 *
 * Small on purpose. 24x24 in, three convolutions and two dense layers out, about 105k
 * weights — a few hundred kilobytes beside a bundle that is already 180. Everything is
 * `Float32Array` and every buffer is allocated once and reused, because the training loop
 * runs this tens of millions of times.
 */

/** The square a glyph is scaled into, matching `pnpm dataset`. */
export const INPUT = 24;

/** Channels after each convolution, and the width of the hidden dense layer. */
const C1 = 16;
const C2 = 32;
const C3 = 64;
const HIDDEN = 128;

/** Side length of the feature map after each pooling step: 24 -> 12 -> 6 -> 3. */
const S1 = INPUT / 2;
const S2 = S1 / 2;
const S3 = S2 / 2;

export interface Shape {
  /** Rows of the weight matrix, as `[inputs, outputs]`. */
  in: number;
  out: number;
}

/** Every weight tensor, in the order the file stores them. */
export const SHAPES = {
  conv1: { in: 1 * 9, out: C1 },
  conv2: { in: C1 * 9, out: C2 },
  conv3: { in: C2 * 9, out: C3 },
  fc1: { in: S3 * S3 * C3, out: HIDDEN },
  fc2: { in: HIDDEN, out: 0 }, // filled in from the class list
} satisfies Record<string, Shape>;

export type TensorName = keyof typeof SHAPES;
export const TENSORS = ['conv1', 'conv2', 'conv3', 'fc1', 'fc2'] as const;

export interface Net {
  /** Class labels, in the order the last layer scores them. */
  classes: string[];
  /** Weight matrices, stored transposed as `[out][in]` so both GEMM reads run contiguously. */
  weights: Record<TensorName, Float32Array>;
  biases: Record<TensorName, Float32Array>;
}

/** Every intermediate a forward pass needs, allocated once for a whole batch. */
export interface Workspace {
  batch: number;
  columns: Float32Array[];
  maps: Float32Array[];
  pooled: Float32Array[];
  /** Which input each pooled cell came from, so the backward pass can route gradients. */
  argmax: Int32Array[];
  hidden: Float32Array;
  logits: Float32Array;
}

const PLANES = [C1, C2, C3];
const SIDES = [INPUT, S1, S2];
const POOLED = [S1, S2, S3];

export function makeWorkspace(batch: number, classes: number): Workspace {
  const columns: Float32Array[] = [];
  const maps: Float32Array[] = [];
  const pooled: Float32Array[] = [];
  const argmax: Int32Array[] = [];

  for (let layer = 0; layer < 3; layer++) {
    const side = SIDES[layer];
    const inputs = layer === 0 ? 1 : PLANES[layer - 1];
    columns.push(new Float32Array(batch * side * side * inputs * 9));
    maps.push(new Float32Array(batch * side * side * PLANES[layer]));
    pooled.push(new Float32Array(batch * POOLED[layer] * POOLED[layer] * PLANES[layer]));
    argmax.push(new Int32Array(batch * POOLED[layer] * POOLED[layer] * PLANES[layer]));
  }

  return {
    batch,
    columns,
    maps,
    pooled,
    argmax,
    hidden: new Float32Array(batch * HIDDEN),
    logits: new Float32Array(batch * classes),
  };
}

/**
 * Lay a padded feature map out so that a convolution becomes one matrix multiply.
 *
 * Each output position gets a row holding the 3x3 neighbourhood of every input channel, so
 * the convolution is `columns * weights`. It costs a copy and buys the inner loop below,
 * which is worth roughly two and a half times the obvious nested-loop convolution.
 *
 * Zero padding of one, so the map keeps its size.
 *
 * Everything here is **channel-last** — a feature map is `[image][y][x][channel]`. That is
 * what pooling produces and what this consumes, so the two compose without a transpose
 * anywhere; a single input image is then just its 24x24 pixels in order.
 */
export function im2col(
  source: Float32Array,
  batch: number,
  channels: number,
  side: number,
  out: Float32Array,
): void {
  let at = 0;

  for (let n = 0; n < batch; n++) {
    const image = n * side * side * channels;

    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        for (let c = 0; c < channels; c++) {
          for (let dy = -1; dy <= 1; dy++) {
            const sy = y + dy;
            for (let dx = -1; dx <= 1; dx++) {
              const sx = x + dx;
              out[at++] =
                sy < 0 || sx < 0 || sy >= side || sx >= side
                  ? 0
                  : source[image + (sy * side + sx) * channels + c];
            }
          }
        }
      }
    }
  }
}

/**
 * `out[m][n] = a[m][k] * bT[n][k]`, with the second matrix stored transposed.
 *
 * Four output columns at a time, each accumulating in its own local, which is what makes
 * this fast: the obvious version accumulates into the output array, so every iteration is a
 * load, a multiply, an add and a store with a dependency chain through memory. Measured on
 * this model, the register version is 1.3x and doing four columns at once is 2.5x.
 */
export function gemm(
  a: Float32Array,
  bT: Float32Array,
  bias: Float32Array | null,
  out: Float32Array,
  m: number,
  k: number,
  n: number,
): void {
  for (let i = 0; i < m; i++) {
    const ai = i * k;
    const oi = i * n;
    let j = 0;

    for (; j + 3 < n; j += 4) {
      const b0 = j * k;
      const b1 = b0 + k;
      const b2 = b1 + k;
      const b3 = b2 + k;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;

      for (let p = 0; p < k; p++) {
        const av = a[ai + p];
        s0 += av * bT[b0 + p];
        s1 += av * bT[b1 + p];
        s2 += av * bT[b2 + p];
        s3 += av * bT[b3 + p];
      }

      out[oi + j] = bias ? s0 + bias[j] : s0;
      out[oi + j + 1] = bias ? s1 + bias[j + 1] : s1;
      out[oi + j + 2] = bias ? s2 + bias[j + 2] : s2;
      out[oi + j + 3] = bias ? s3 + bias[j + 3] : s3;
    }

    for (; j < n; j++) {
      const bj = j * k;
      let sum = 0;
      for (let p = 0; p < k; p++) sum += a[ai + p] * bT[bj + p];
      out[oi + j] = bias ? sum + bias[j] : sum;
    }
  }
}

/** Rectify in place, which is all a ReLU is on the way forward. */
function relu(values: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) if (values[i] < 0) values[i] = 0;
}

/**
 * Halve a feature map by taking the largest of each 2x2 block, recording which one won so
 * the backward pass knows where to send the gradient.
 *
 * The map is stored with position varying fastest over channels — the layout `im2col`
 * wants next — so this reads `[y][x][channel]` and writes the same.
 */
function maxPool(
  source: Float32Array,
  batch: number,
  side: number,
  channels: number,
  out: Float32Array,
  argmax: Int32Array,
): void {
  const half = side / 2;

  for (let n = 0; n < batch; n++) {
    const image = n * side * side * channels;
    const target = n * half * half * channels;

    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        for (let c = 0; c < channels; c++) {
          let best = -Infinity;
          let from = -1;

          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const at = image + ((y * 2 + dy) * side + x * 2 + dx) * channels + c;
              if (source[at] > best) {
                best = source[at];
                from = at;
              }
            }
          }

          const to = target + (y * half + x) * channels + c;
          out[to] = best;
          argmax[to] = from;
        }
      }
    }
  }
}

/**
 * Score a batch of glyphs. `input` holds `batch` images of 24x24, values in 0..1.
 *
 * Leaves the logits in `space.logits`; `softmax` turns them into probabilities where a
 * caller wants confidence rather than a winner.
 */
export function forward(net: Net, input: Float32Array, batch: number, space: Workspace): void {
  let source = input;
  let channels = 1;

  for (let layer = 0; layer < 3; layer++) {
    const side = SIDES[layer];
    const planes = PLANES[layer];
    const name = TENSORS[layer];

    im2col(source, batch, channels, side, space.columns[layer]);
    gemm(
      space.columns[layer],
      net.weights[name],
      net.biases[name],
      space.maps[layer],
      batch * side * side,
      channels * 9,
      planes,
    );
    relu(space.maps[layer], batch * side * side * planes);
    maxPool(space.maps[layer], batch, side, planes, space.pooled[layer], space.argmax[layer]);

    source = space.pooled[layer];
    channels = planes;
  }

  gemm(source, net.weights.fc1, net.biases.fc1, space.hidden, batch, SHAPES.fc1.in, HIDDEN);
  relu(space.hidden, batch * HIDDEN);
  gemm(
    space.hidden,
    net.weights.fc2,
    net.biases.fc2,
    space.logits,
    batch,
    HIDDEN,
    net.classes.length,
  );
}

/** Turn one row of logits into probabilities, in place. */
export function softmax(values: Float32Array, from: number, count: number): void {
  let top = -Infinity;
  for (let i = 0; i < count; i++) if (values[from + i] > top) top = values[from + i];

  let total = 0;
  for (let i = 0; i < count; i++) {
    const value = Math.exp(values[from + i] - top);
    values[from + i] = value;
    total += value;
  }

  for (let i = 0; i < count; i++) values[from + i] /= total;
}

/** The best-scoring class for one row, with its probability. */
export function best(
  logits: Float32Array,
  from: number,
  count: number,
): { index: number; probability: number } {
  let index = 0;
  for (let i = 1; i < count; i++) if (logits[from + i] > logits[from + index]) index = i;

  return { index, probability: logits[from + index] };
}

/** How much of the input square a glyph may fill, leaving a margin around it. */
const CONTENT = 20;

/**
 * Scale a glyph into the input square, **keeping its proportions**.
 *
 * Shared with `pnpm dataset` so that what the net is trained on and what it is shown are
 * produced by the same code. Scaling a glyph even slightly differently between the two is
 * the sort of mismatch that costs a day: the model scores well in training and reads
 * nonsense in the app, with nothing obviously wrong on either side.
 *
 * Unlike `normalize` in `digits.ts`, which stretches a glyph to fill a 12x16 grid and throws
 * its shape away — the very thing that makes a bare-stroke 1 look like a lump of ink, and
 * that three of the hand-written rules there exist to work around. Here a narrow 1 stays
 * narrow and a circle stays round, and the net can use that.
 *
 * Ink is taken from a block of source pixels if *any* of them is inked, which keeps
 * one-pixel strokes alive: losing one is enough to take the bar off a 2.
 */
export function toInput(
  glyph: { width: number; height: number; pixels: Uint8Array },
  into: Float32Array,
  offset = 0,
): void {
  const scale = Math.min(CONTENT / glyph.width, CONTENT / glyph.height);
  const width = Math.max(1, Math.round(glyph.width * scale));
  const height = Math.max(1, Math.round(glyph.height * scale));
  const left = Math.floor((INPUT - width) / 2);
  const top = Math.floor((INPUT - height) / 2);

  into.fill(0, offset, offset + INPUT * INPUT);

  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * glyph.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * glyph.height) / height));

    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * glyph.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * glyph.width) / width));

      let ink = 0;
      for (let sy = sy0; sy < sy1 && ink === 0; sy++) {
        for (let sx = sx0; sx < sx1 && ink === 0; sx++) {
          if (glyph.pixels[sy * glyph.width + sx] === 1) ink = 1;
        }
      }
      into[offset + (top + y) * INPUT + left + x] = ink;
    }
  }
}

/** Everything the layers need, sized from a class list. */
export function makeNet(classes: string[], fill: (size: number, fan: number) => Float32Array): Net {
  const weights = {} as Record<TensorName, Float32Array>;
  const biases = {} as Record<TensorName, Float32Array>;

  for (const name of TENSORS) {
    const shape = { ...SHAPES[name] };
    if (name === 'fc2') shape.out = classes.length;

    weights[name] = fill(shape.in * shape.out, shape.in);
    biases[name] = new Float32Array(shape.out);
  }

  return { classes, weights, biases };
}

/** Output width of each tensor, once the class list is known. */
export function outputsOf(name: TensorName, classes: number): number {
  return name === 'fc2' ? classes : SHAPES[name].out;
}
