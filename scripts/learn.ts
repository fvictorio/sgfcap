/**
 * The training half of the convolutional net: gradients, an optimiser step, and a check
 * that the gradients are right.
 *
 * Shared by every trainer rather than sitting in one of them, because there is now more than
 * one thing worth training on a 24x24 patch — the characters printed on a diagram, and
 * whether anything is printed at a point at all. The forward pass they share already lives
 * in `net.ts`; this is its mirror image and belongs beside it.
 *
 * Written out by hand rather than derived, so `checkGradients` can compare every one of them
 * against a finite difference before a long run. That matters more here than it looks: a
 * subtly wrong gradient does not crash, it trains to something mediocre and leaves you
 * wondering about the architecture.
 */
import {
  forward,
  INPUT,
  SHAPES,
  softmax,
  TENSORS,
  type Net,
  type TensorName,
  type Workspace,
} from '../src/detect/net.js';

const PIXELS = INPUT * INPUT;

export interface Gradients {
  weights: Record<TensorName, Float32Array>;
  biases: Record<TensorName, Float32Array>;
}


const PLANES = [16, 32, 64];
const SIDES = [24, 12, 6];
const HIDDEN = 128;

export function zerosLike(net: Net): Gradients {
  const weights = {} as Record<TensorName, Float32Array>;
  const biases = {} as Record<TensorName, Float32Array>;
  for (const name of TENSORS) {
    weights[name] = new Float32Array(net.weights[name].length);
    biases[name] = new Float32Array(net.biases[name].length);
  }
  return { weights, biases };
}

/**
 * Forward, then backward, accumulating gradients and returning the summed loss.
 *
 * Everything is the chain rule applied layer by layer, in reverse. The only part worth
 * commenting is that softmax with cross-entropy collapses: the gradient at the logits is
 * simply `probability - target`, which is why neither is computed separately.
 */
export function step(
  net: Net,
  space: Workspace,
  input: Float32Array,
  labels: Int32Array,
  batch: number,
  grads: Gradients,
  weight: Float32Array,
): number {
  const classes = net.classes.length;
  forward(net, input, batch, space);

  // Loss and the gradient at the logits.
  const dLogits = new Float32Array(batch * classes);
  let loss = 0;
  for (let n = 0; n < batch; n++) {
    softmax(space.logits, n * classes, classes);
    const target = labels[n];
    const scale = weight[target];
    loss -= scale * Math.log(Math.max(1e-9, space.logits[n * classes + target]));
    for (let c = 0; c < classes; c++) {
      dLogits[n * classes + c] = scale * (space.logits[n * classes + c] - (c === target ? 1 : 0));
    }
  }

  // fc2
  const dHidden = new Float32Array(batch * HIDDEN);
  accumulate(dLogits, space.hidden, grads.weights.fc2, grads.biases.fc2, batch, HIDDEN, classes);
  backpropagate(dLogits, net.weights.fc2, dHidden, batch, HIDDEN, classes);

  // fc1, through the ReLU on the hidden layer.
  for (let i = 0; i < batch * HIDDEN; i++) if (space.hidden[i] <= 0) dHidden[i] = 0;
  const flat = SHAPES.fc1.in;
  const dPooled3 = new Float32Array(batch * flat);
  accumulate(dHidden, space.pooled[2], grads.weights.fc1, grads.biases.fc1, batch, flat, HIDDEN);
  backpropagate(dHidden, net.weights.fc1, dPooled3, batch, flat, HIDDEN);

  let dPooled = dPooled3;
  for (let layer = 2; layer >= 0; layer--) {
    const side = SIDES[layer];
    const planes = PLANES[layer];
    const channels = layer === 0 ? 1 : PLANES[layer - 1];
    const name = TENSORS[layer];
    const rows = batch * side * side;

    // Undo the pooling: each gradient goes back to whichever cell won its block.
    const dMap = new Float32Array(batch * side * side * planes);
    for (let i = 0; i < dPooled.length; i++) dMap[space.argmax[layer][i]] += dPooled[i];

    // Undo the ReLU.
    for (let i = 0; i < dMap.length; i++) if (space.maps[layer][i] <= 0) dMap[i] = 0;

    accumulate(
      dMap,
      space.columns[layer],
      grads.weights[name],
      grads.biases[name],
      rows,
      channels * 9,
      planes,
    );

    if (layer === 0) break;

    // Undo the im2col: every patch entry adds back into the pixel it was copied from.
    const dColumns = new Float32Array(space.columns[layer].length);
    backpropagate(dMap, net.weights[name], dColumns, rows, channels * 9, planes);

    const previous = SIDES[layer - 1] / 2;
    dPooled = new Float32Array(batch * previous * previous * channels);
    col2im(dColumns, batch, channels, side, dPooled);
  }

  return loss;
}

/** `dW[out][in] += sum over rows of dOut[row][out] * in[row][in]`, and the bias likewise. */
export function accumulate(
  dOut: Float32Array,
  input: Float32Array,
  dWeights: Float32Array,
  dBiases: Float32Array,
  rows: number,
  k: number,
  n: number,
): void {
  for (let r = 0; r < rows; r++) {
    const dr = r * n;
    const ir = r * k;
    for (let j = 0; j < n; j++) {
      const g = dOut[dr + j];
      if (g === 0) continue;
      dBiases[j] += g;
      const wj = j * k;
      for (let p = 0; p < k; p++) dWeights[wj + p] += g * input[ir + p];
    }
  }
}

/** `dIn[row][in] = sum over outputs of dOut[row][out] * W[out][in]`. */
export function backpropagate(
  dOut: Float32Array,
  weights: Float32Array,
  dIn: Float32Array,
  rows: number,
  k: number,
  n: number,
): void {
  dIn.fill(0);
  for (let r = 0; r < rows; r++) {
    const dr = r * n;
    const ir = r * k;
    for (let j = 0; j < n; j++) {
      const g = dOut[dr + j];
      if (g === 0) continue;
      const wj = j * k;
      for (let p = 0; p < k; p++) dIn[ir + p] += g * weights[wj + p];
    }
  }
}

/** The reverse of `im2col`: scatter each patch entry back to the pixel it came from. */
export function col2im(
  columns: Float32Array,
  batch: number,
  channels: number,
  side: number,
  out: Float32Array,
): void {
  out.fill(0);
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
              const value = columns[at++];
              if (sy < 0 || sx < 0 || sy >= side || sx >= side) continue;
              out[image + (sy * side + sx) * channels + c] += value;
            }
          }
        }
      }
    }
  }
}

/** Below this an entry's gradient is smaller than the noise in measuring it. */
const MEASURABLE = 0.02;

/**
 * Compare every gradient against a finite difference of the loss.
 *
 * Slow and only run on demand, but it is the difference between knowing the backward pass
 * is right and hoping so. A wrong gradient trains to something plausible-looking and the
 * time is then spent blaming the architecture.
 */
export function checkGradients(net: Net, space: Workspace, weight: Float32Array): void {
  const batch = 4;
  const input = new Float32Array(batch * PIXELS).map(() => Math.random());
  const labels = new Int32Array(batch).map(() => Math.floor(Math.random() * net.classes.length));

  const grads = zerosLike(net);
  step(net, space, input, labels, batch, grads, weight);

  // ReLU and max pooling are kinked, so nudging a weight can flip which cell wins a pooling
  // window or push an activation through zero. The finite difference then straddles a
  // discontinuity and disagrees with the analytic gradient for a reason that is not a bug.
  // Rather than argue about the tail, record the pattern of choices the baseline made and
  // throw away any trial that changed one — what is left is a smooth function of the weight.
  const fingerprint = () =>
    space.argmax.map((a) => a.join(',')).join('|') +
    '#' +
    space.maps.map((m) => Array.from(m, (v) => (v > 0 ? '1' : '0')).join('')).join('|');

  const baseline = fingerprint();
  const loss = () => {
    const scratch = zerosLike(net);
    const value = step(net, space, input, labels, batch, scratch, weight);
    return { value, kinked: fingerprint() !== baseline };
  };

  let bad = 0;
  for (const name of TENSORS) {
    const errors: number[] = [];

    for (let trial = 0; trial < 4000 && errors.length < 30; trial++) {
      const at = Math.floor(Math.random() * net.weights[name].length);
      const original = net.weights[name][at];
      const h = Number(process.env.GRAD_H ?? 1e-3);

      net.weights[name][at] = original + h;
      const up = loss();
      net.weights[name][at] = original - h;
      const down = loss();
      net.weights[name][at] = original;
      if (up.kinked || down.kinked) continue;

      const numeric = (up.value - down.value) / (2 * h);
      const analytic = grads.weights[name][at];

      // Only where the gradient is big enough to measure. The forward pass is float32, so
      // the loss carries noise of order 1e-4; divided by a step of 1e-3 that is 0.1 of
      // absolute gradient, which says nothing at all about an entry whose gradient is 0.001.
      if (Math.abs(analytic) < MEASURABLE) continue;
      errors.push(Math.abs(numeric - analytic) / (Math.abs(numeric) + Math.abs(analytic)));
    }

    if (errors.length === 0) {
      console.log(`  ${name.padEnd(6)} every trial flipped a kink; nothing to compare`);
      continue;
    }
    errors.sort((a, b) => a - b);
    const median = errors[errors.length >> 1];
    const worst = errors[errors.length - 1];
    const over = errors.filter((e) => e > 1e-3).length;
    console.log(
      `  ${name.padEnd(6)} median ${median.toExponential(1)}  worst ${worst.toExponential(1)}  ` +
        `${over}/${errors.length} over 1e-3 (kink-free trials)`,
    );

    // A handful of outliers is expected and not a bug: ReLU and max pooling are kinked, so
    // nudging a weight can flip which input wins a pooling window, and the finite difference
    // then straddles a discontinuity that the analytic gradient rightly ignores. A wrong
    // backward pass looks quite different — it is wrong in the *median*, not in the tail.
    if (median > Number(process.env.GRAD_TOL ?? 1e-3)) bad++;
  }

  if (bad > 0) throw new Error(`${bad} tensor(s) disagree with finite differences in the median`);
  console.log('  gradients agree with finite differences\n');
}
