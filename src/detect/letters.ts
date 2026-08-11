/**
 * Making the reference letters on a diagram agree with each other.
 *
 * The same idea as `sequence.ts`, applied to the other thing a diagram prints. Books letter
 * the points their prose refers to in a run — a, b, c, and so on — and never use the same
 * letter twice. Checked across the corpus, every diagram that letters anything does exactly
 * that, and one of them does it in capitals.
 *
 * What is *not* assumed is where the run starts or how long it is. Hardcoding `a` to `f`
 * would read six letters correctly and quietly mangle the first diagram that prints eight,
 * and it would have no answer at all for the one printing `A` and `B`. Instead every run of
 * the right length is tried, in both cases, and the one the readings themselves like best
 * wins. The constraint is that the letters form *a* run; which run is evidence, not
 * assumption.
 */

/** A point carrying a letter, and every letter the reader thinks it might be. */
export interface Lettered<T> {
  point: T;
  options: ReadonlyArray<{ text: string; score: number }>;
  /** What the reader made of it on its own, or undefined where it would not say. */
  read?: string;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();

/**
 * How much better than nothing a run has to score before it is preferred to the plain
 * best-guess reading.
 *
 * A run that no point has any evidence for is not an improvement on reading each point on
 * its own; it is a different way of being wrong. This asks that on average the letters it
 * hands out are ones the reader had some real time for.
 */
const MIN_MEAN_SCORE = 0.2;

/**
 * What each step away from the start of the alphabet costs a run, against a score of one per
 * letter.
 *
 * Books letter the points their prose refers to a, b, c, in order from the beginning — every
 * diagram in the corpus that letters anything does, including the one that does it in
 * capitals. That is a real regularity and worth leaning on, but leaning is all it is: a
 * diagram that genuinely starts at `d` only has to read a little better as `d` than as `a` to
 * be believed. Without it, a pair of letters read poorly can find a flattering run halfway
 * down the alphabet — `2026-08-13_17-52` reads its `a` and `b` as `g` and `h` given the
 * chance, which is worse than the per-point reading it replaced.
 */
const LATE_START_COST = 0.06;

/**
 * Choose the letters, or return null to leave the per-point readings alone.
 *
 * Returns one letter per point in the order given.
 */
export function resolve<T>(points: ReadonlyArray<Lettered<T>>): Array<string | null> | null {
  const n = points.length;
  if (n === 0) return null;

  let best: { letters: Array<string | null>; total: number } | null = null;

  for (const alphabet of [LOWER, UPPER]) {
    for (let start = 0; start + n <= alphabet.length; start++) {
      const run = alphabet.slice(start, start + n).split('');

      // Best pairing of this run to these points, taken greedily by strength of evidence:
      // the clearest reading is served first and the rest fit around it, which is what makes
      // one confident letter enough to place the others.
      const pairs: Array<{ at: number; letter: string; score: number }> = [];
      points.forEach((p, at) => {
        for (const option of p.options) {
          if (run.includes(option.text)) pairs.push({ at, letter: option.text, score: option.score });
        }
      });
      pairs.sort((a, b) => b.score - a.score);

      const letters: Array<string | null> = new Array(n).fill(null);
      const used = new Set<string>();
      let total = 0;
      for (const { at, letter, score } of pairs) {
        if (letters[at] !== null || used.has(letter)) continue;
        letters[at] = letter;
        used.add(letter);
        total += score;
      }

      // A run nobody can spell is no use; every point has to end up with a letter.
      if (letters.some((l) => l === null)) continue;
      const merit = total - start * LATE_START_COST;
      if (best === null || merit > best.total) best = { letters, total: merit };
    }
  }

  if (best === null || best.total / n < MIN_MEAN_SCORE) return null;
  return best.letters;
}
