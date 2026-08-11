/**
 * Making a set of read move numbers agree with what a move sequence can actually be.
 *
 * Every other stage of the reader looks at one point at a time. This one looks at all of them
 * together, and it can do that because a numbered diagram is far more constrained than the
 * pixels alone suggest. Checked against every fixture in the corpus, without exception:
 *
 *   - the numbers form a **contiguous run**, `k` through `k + n - 1`
 *   - the colours **strictly alternate** with the numbers, so parity fixes colour
 *
 * That is a great deal of information, and until now the reader threw all of it away — it
 * read each stone on its own and reported whatever came back, including numbers that repeat,
 * numbers of the wrong colour, and gaps in the middle of a run.
 *
 * What is done with it is deliberately conservative. This never overrules a reading that is
 * consistent; it only redistributes numbers that *cannot* be right. A reading is impossible
 * if the number is claimed by a better-placed stone as well, if its parity contradicts the
 * colour of the stone it is printed on, or if it falls outside the run everything else
 * agrees on. Those stones give their numbers up and the numbers the run is missing are dealt
 * back out to them, matching parity to colour, which is the only assignment consistent with
 * the rules of the game.
 *
 * Where that still leaves a choice — two black stones and two odd numbers going spare — it
 * makes none, and leaves them unnumbered. Guessing between them would be inventing a move
 * order the picture does not support, and a wrong number is worse than a missing one.
 */
import type { StoneColor } from '../types.js';

export interface Numbered<T> {
  stone: T;
  color: StoneColor;
  /** What the reader made of the number printed on it, or null if it read none. */
  order: number | null;
  /** Whether the stone carries printing at all, read or not — see `stoneIsInked`. */
  inked: boolean;
  /** Every number it might be carrying, with how well each fits. Best first. */
  options: ReadonlyArray<{ order: number; score: number }>;
}

/** How much of the sequence has to agree on a parity before it is taken as the rule. */
const PARITY_MAJORITY = 0.6;

/**
 * How far ahead of its nearest rival a pairing has to be to be acted on.
 *
 * The sequence often knows which numbers are missing without knowing which stone carries
 * which. Where the readings do not clearly say, the honest answer is to leave the stones
 * unnumbered, so a pairing is only taken when nothing else comes close to it.
 */
const DECISIVE = 1.0;

/**
 * How far a stone's favourite among the missing numbers must beat its own second favourite.
 *
 * The pairing being best on both sides is not enough on its own, because it can be best among
 * candidates that are all equally poor. `2026-08-14_10-29` prints five black moves whose
 * digits neither reader can make out, and the scores come back flat — 1 at 0.70, 5 at 0.70, 3
 * at 0.66 — so whichever happens to sort first wins and four of the five land on the wrong
 * stone. Asking the stone to have a preference of its own separates that from the case where
 * it plainly reads as one number and simply lost its place in the run.
 */
const OPINIONATED = 1.08;

/**
 * What one number of extra span costs, measured in readings that fit inside it.
 *
 * The run is not always as long as there are stones to carry it. A diagram continuing a game
 * prints the position as it stands, and a stone that was played and then captured is simply
 * not there — `2026-08-20_00-51` prints 67 numbered stones covering 71 to 146, with nine
 * numbers absent because those stones came off the board. Insisting the span equal the count
 * puts the run at 71 to 137 and throws away five move numbers the reader had right at the top
 * of it.
 *
 * But span cannot be free, or one wildly misread number drags the run out to meet it and
 * takes every reading with it — the case the trimming exists for, where `2026-08-11_14-37`
 * reads move 19 as 49 and stretches a 35-move run to 49. So a longer run has to buy each
 * extra number it spans: at this price four of them cost one reading that fits, which still
 * leaves 14-37 preferring the short run by a wide margin and `itb-01` — a 14-move diagram
 * reading its 14 as 44 — preferring it by more.
 *
 * Dearer than this and the nine gaps in `2026-08-20_00-51` are more than its top end can
 * afford, so the run stops at 142 and a correctly read 145 is thrown out as impossible.
 * Cheaper and `2026-08-14_10-45` starts buying span it has no readings for.
 */
const EXCESS = 0.25;

/**
 * Re-deal the numbers that cannot be right, and return the order each stone should carry.
 *
 * Returns a parallel array: a number where one is settled, null where the stone is better
 * left as an unnumbered setup stone.
 */
export function reconcile<T>(stones: ReadonlyArray<Numbered<T>>): Array<number | null> {
  const settled: Array<number | null> = stones.map((s) => s.order);
  const read = stones.filter((s) => s.order !== null);
  if (read.length < 3) return settled;

  // Which colour plays the odd numbers. Books number from either side — a diagram continuing
  // a game may open on white — so it is read off the stones rather than assumed.
  let oddBlack = 0;
  let oddWhite = 0;
  for (const s of read) {
    const black = s.color === 'b';
    if ((s.order! % 2 === 1) === black) oddBlack += 1;
    else oddWhite += 1;
  }
  const agreement = Math.max(oddBlack, oddWhite) / (oddBlack + oddWhite);
  if (agreement < PARITY_MAJORITY) return settled;
  const oddColour: StoneColor = oddBlack >= oddWhite ? 'b' : 'w';
  const wants = (order: number): StoneColor =>
    order % 2 === 1 ? oddColour : oddColour === 'b' ? 'w' : 'b';

  // Parity first, then duplicates, and the order matters. A misread number often lands on one
  // that another stone holds correctly, and doubting both copies leaves the gap unfillable and
  // the right reading thrown away with the wrong one. Colour settles most of those outright:
  // of the two stones claiming 2, only one can be the colour that plays even moves.
  const contradicts = (s: Numbered<T>) => wants(s.order!) !== s.color;
  const consistent = read.filter((s) => !contradicts(s));

  const seen = new Map<number, number>();
  for (const s of consistent) seen.set(s.order!, (seen.get(s.order!) ?? 0) + 1);

  const trusted = consistent.filter((s) => seen.get(s.order!) === 1);
  if (trusted.length === 0) return settled;

  const orders = trusted.map((s) => s.order!).sort((a, b) => a - b);
  let low = orders[0];
  let high = orders[orders.length - 1];

  // The run is exactly as long as there are stones with numbers printed on them, and that
  // settles where it lies. A single badly misread number otherwise drags one end out to meet
  // it and takes every reading with it: `2026-08-11_14-37` prints moves 1 to 35 and reads
  // move 19 as 49. Nothing else here doubts a 49 — it is unique, and it is the right colour
  // for its parity — so the run stretches to 1 through 49, fourteen numbers go missing at
  // once, and the one real mistake is buried among them.
  //
  // Thirty-five stones cannot carry a run of forty-nine. So the window of the right length
  // holding the most readings is taken as the run, and whatever falls outside it is doubted
  // along with everything else that could not be right.
  const inked = stones.filter((s) => s.inked).length;
  if (inked > 0) {
    // Every start a reading could imply, and one as well, because books number from one far
    // more often than they do not and a sequence whose first move went unread has nothing
    // else to suggest it.
    const starts = [...new Set([1, ...orders.map((o) => Math.max(1, o))])].sort((a, b) => a - b);
    const ends = [...new Set(orders)].sort((a, b) => a - b);

    let best = -Infinity;
    for (const start of starts) {
      for (const end of ends) {
        // A run can span more numbers than there are stones to carry them, never fewer.
        const stop = Math.max(end, start + inked - 1);
        const span = stop - start + 1;
        const within = orders.filter((o) => o >= start && o <= stop).length;
        const score = within - EXCESS * (span - inked);
        // Strictly greater, so a tie goes to the shortest span and earliest start, which is
        // the order the candidates are generated in.
        if (score > best) {
          best = score;
          low = start;
          high = stop;
        }
      }
    }
  }

  // A run has to hold every number between its ends; if the readings are too sparse for that
  // even after trimming, the picture is not a numbered sequence and nothing here applies.
  //
  // Checked after the trimming rather than before, which matters more than it sounds. One
  // wildly misread number is enough to stretch the ends past any board — `itb-01` reads a 14
  // as 44 on a diagram of fourteen moves — and testing first meant giving up on exactly the
  // diagrams that needed the most help, while the sequence sat there knowing perfectly well
  // that fourteen stones cannot carry forty-four numbers.
  if (high - low + 1 > stones.length) return settled;

  // How much of the run the readings themselves reach, as opposed to how far it was inferred
  // to stretch. Only this part is trusted enough to hand a number out on no evidence at all.
  const inside = orders.filter((o) => o >= low && o <= high);
  const trustedLow = inside.length > 0 ? inside[0] : low;
  const trustedHigh = inside.length > 0 ? inside[inside.length - 1] : high;

  const claimed = new Set(orders);
  const doubted: number[] = [];
  stones.forEach((s, i) => {
    if (s.order === null) {
      doubted.push(i);
      return;
    }
    const ok =
      !contradicts(s as Numbered<T>) &&
      seen.get(s.order) === 1 &&
      s.order >= low &&
      s.order <= high;
    if (!ok) {
      settled[i] = null;
      doubted.push(i);
    }
  });

  const missing: number[] = [];
  for (let n = low; n <= high; n++) if (!claimed.has(n)) missing.push(n);
  if (missing.length === 0) return settled;

  // Deal the gaps out by colour. A number goes to a doubted stone only when exactly one
  // doubted stone of that colour is left wanting one — anything else is a guess.
  //
  // Only stones with something printed on them are in the running. A diagram sets out a
  // position and then plays into it, so most of its blank stones are setup and were never
  // numbered; counting those as candidates leaves every gap with a dozen takers and nothing
  // is ever settled. `some-diagram-2` has ten of them against two unread moves.
  // Where a stone offers alternatives, the best-fitting pairing of gaps to stones wins. Every
  // legal pairing is scored by how well that stone reads as that number and taken in order,
  // so the clearest evidence is spent first and the rest has to fit around it.
  const pairs: Array<{ at: number; order: number; score: number }> = [];
  for (const n of missing) {
    for (const i of doubted) {
      if (!stones[i].inked || stones[i].color !== wants(n)) continue;
      const option = stones[i].options.find((o) => o.order === n);
      if (option) pairs.push({ at: i, order: n, score: option.score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  // Only pairings that are clearly the best on both sides are taken: the best number for that
  // stone, the best stone for that number, and beaten by nothing close.
  //
  // Greedy assignment was tried and it is worse than doing nothing. `2026-08-14_10-29` prints
  // five black moves whose numbers the reader cannot make out; the sequence works out that
  // they must be 1, 3, 5, 7 and 9, and greed then deals them round in the wrong order and
  // gets four of the five wrong where leaving them blank got none wrong. Knowing the set is
  // not knowing the assignment, and a number in the wrong place is worse than a gap.
  const spoken = new Set<number>();
  for (let k = 0; k < pairs.length; k++) {
    const { at, order, score } = pairs[k];
    if (settled[at] !== null || spoken.has(order)) continue;

    const rival = pairs.find(
      (p, j) => j !== k && (p.at === at || p.order === order) && settled[p.at] === null && !spoken.has(p.order),
    );
    if (rival && rival.score > score * DECISIVE) continue;

    // The stone has to prefer this number to the other numbers still going spare, and by
    // enough that the preference means something.
    const second = pairs.find(
      (p, j) => j !== k && p.at === at && !spoken.has(p.order) && settled[p.at] === null,
    );
    if (second && score < second.score * OPINIONATED) continue;

    settled[at] = order;
    spoken.add(order);
  }

  // Anything still missing falls back to the one case that needs no evidence at all: exactly
  // one stone of the right colour is left wanting a number, so it can only be that one.
  //
  // Only within the span the readings actually vouch for. Beyond it the run is this function's
  // own inference, and handing a number to a stone on no evidence, inside a span that was
  // itself inferred, is two guesses stacked. Measured either way it changes nothing, so the
  // narrower rule stands.
  for (const n of missing) {
    if (spoken.has(n) || n < trustedLow || n > trustedHigh) continue;
    const takers = doubted.filter(
      (i) => settled[i] === null && stones[i].inked && stones[i].color === wants(n),
    );
    if (takers.length === 1) {
      settled[takers[0]] = n;
      spoken.add(n);
    }
  }

  return settled;
}
