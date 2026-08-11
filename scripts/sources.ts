/**
 * Which book each fixture came out of, and which books are never trained on.
 *
 * Splitting a corpus of diagrams at random is the fastest way to a number that means
 * nothing. Every intersection of one diagram shares a typeface, a printing, a scanner and a
 * page; hold out a tenth of the *points* and a model can score astonishingly well by
 * recognising the page rather than the go. The only split that answers the question actually
 * being asked — will this read the next book I photograph — puts whole sources on one side
 * or the other.
 *
 * Fixture names carry the source already. The named ones say it outright, `litfog-04b` and
 * `otme-01` being two pages of one book each. The dated ones do not, so a whole day's batch
 * is treated as one source: a sitting is usually one or two books, and lumping a day together
 * risks nothing worse than a slightly pessimistic split, where splitting it risks the same
 * page landing on both sides.
 */

/** Held-out sources, named rather than hashed, so the split cannot drift when a fixture lands. */
const HELD_OUT = new Set(['litfog', 'otme', '2026-08-14']);

/**
 * The generated diagrams, which are their own source and never held out.
 *
 * They are drawn by us, so they say nothing about whether a model generalises to a book it
 * has not seen — measuring against them would only report how well the generator was
 * learned. They are useful to train on and worthless to validate on.
 */
export const GENERATED = 'generated';

export function sourceOf(name: string): string {
  if (name.startsWith('generated/') || name.startsWith('drawn/')) return GENERATED;

  // A dated batch: everything photographed that day counts as one source.
  const dated = /^(\d{4}-\d{2}-\d{2})_/.exec(name);
  if (dated) return dated[1];

  // `litfog-04b` and `otme-01` are pages; `litfog` and `otme` are the books they are from.
  return name.replace(/-\d+[a-z]?$/, '').replace(/_\d+$/, '');
}

/** Whether this fixture is one a model must never be trained on. */
export function isHeldOut(name: string): boolean {
  return HELD_OUT.has(sourceOf(name));
}

/** The split a fixture belongs to, as recorded beside every sample cut from it. */
export function splitOf(name: string): 'train' | 'held-out' {
  return isHeldOut(name) ? 'held-out' : 'train';
}
