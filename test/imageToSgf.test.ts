import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageToSgf, type ReadOptions } from '../src/imageToSgf.js';
import { humanCoord, parseSgf } from '../src/sgf.js';
import { stonesWithoutLiberties } from './helpers/compare.js';
import { discoverFixtures } from './helpers/fixtures.js';
import { decodePng } from './helpers/png.js';
import { scoreReading, UNREADABLE, type Reading } from './helpers/score.js';

/**
 * How well the whole corpus reads, rather than whether each image reads perfectly.
 *
 * Every fixture scores from 0 to 1 — see `helpers/score.ts` — and the suite fails on three
 * things: a diagram that produces no board at all, a diagram with any stone wrong, a diagram
 * read so badly it is useless, and the books as a body falling below what they read at today.
 *
 * Stones are held to a different standard from everything else. A misread number is one
 * claim among many and the score says so, but a stone missing or invented is the position
 * itself being wrong — and a position that is wrong is not a reading of that diagram at all,
 * however well the rest of it came out.
 *
 * Deliberately not a ratchet on individual scores. Locking each fixture where it stands
 * makes every small change a negotiation, and the point of the corpus is that images can be
 * dropped in freely and kept as evidence — including ones nothing reads yet. The run prints
 * how each score moved since last time so drift is visible; it just does not gate on it.
 */

/**
 * A diagram this far below right is not a reading, whatever it scored.
 *
 * Deliberately left low while the averages rise. This is the acute check, not the gradual
 * one: it is here to catch an image that came out as something other than a reading of that
 * diagram, and raising it towards where the corpus actually sits — the worst book reads 0.875
 * — would start rejecting hard images on the day they arrive, which is exactly what the
 * corpus is meant to let you avoid.
 */
const FLOOR = 0.5;

/**
 * What the books have to average, per reader.
 *
 * Set about two points under where the reader stands today — 0.999 — because two points is
 * what one fixture is worth. A book collapsing from
 * right to unreadable moves a 54-book average by 0.019, and so does dropping in two new
 * images that read at half marks. Both should be possible without turning the suite red: the
 * first is caught by `FLOOR` and named there, and the second is the whole point of scoring
 * rather than passing. What this catches is the other thing — every fixture slipping a
 * little at once, which no single-image check would notice.
 *
 * Raise them as the corpus improves, keeping that two points of room.
 */
const BOOKS_MUST_AVERAGE: Record<string, number> = { classifier: 0.98 };

/**
 * Long enough for the corpus to grow into.
 *
 * One test now reads every fixture, so the default five seconds is a limit on how many
 * images the project may have rather than on anything going wrong.
 */
const TIMEOUT = 300_000;

/** Generated fixtures are curated to pass, so they are averaged apart from the books. */
const GENERATED = 'generated/';

const SCORES = fileURLToPath(new URL('../.fixture-scores.json', import.meta.url));

/**
 * What each fixture scored the first time it was ever read, and never anything else.
 *
 * Committed, unlike `.fixture-scores.json`, because it is the one number here that cannot be
 * reconstructed. Everything else the suite reports is measured against a corpus that has been
 * tuned with every one of these images in view, so it says how well the reader fits what it
 * has already been shown. A fixture's very first reading is the only time it is unseen data,
 * and once anything is changed in response to it that measurement is gone for good.
 *
 * So it is taken once and frozen. The average over these is the honest answer to whether the
 * reader is getting better at diagrams or just better at this corpus — and it is the number
 * to watch as images accumulate, since it is the only one a new image can move.
 *
 * Fixtures already present when this started are marked `predates` and carry no score: they
 * had all been read and fixed long before, and inventing a first sight for them would put a
 * fitted number in the one place that must not have any.
 */
const FIRST_SIGHT = fileURLToPath(new URL('./first-sight.json', import.meta.url));

interface FirstSight {
  predates?: true;
  on?: string;
  scores?: Record<string, number>;
}

const firstSight: Record<string, FirstSight> = existsSync(FIRST_SIGHT)
  ? JSON.parse(readFileSync(FIRST_SIGHT, 'utf8'))
  : {};

/**
 * One reader, which is the trained classifier — `imageToSgf` uses it unless told otherwise.
 *
 * There were two of these until the prototype matcher was removed. It read shapes it had been
 * shown by the fixtures themselves, so a character no fixture happened to print was one it
 * could never learn, and it ended up behind on the corpus as well as in principle.
 */
const readers: Array<[string, ReadOptions]> = [['classifier', {}]];

const fixtures = discoverFixtures();
const previous: Record<string, Record<string, number>> = existsSync(SCORES)
  ? JSON.parse(readFileSync(SCORES, 'utf8'))
  : {};
const current: Record<string, Record<string, number>> = {};

describe('reading the fixtures', () => {
  for (const [readerName, how] of readers) {
    it(`with the ${readerName}`, async () => {
      const scored: Array<{ name: string; reading: Reading; unreadable: boolean; illegal: string }> = [];

      for (const fixture of fixtures) {
        const expected = parseSgf(fixture.expectedSgf);
        let reading = UNREADABLE;
        let unreadable = true;
        let illegal = '';

        try {
          const actual = parseSgf(await imageToSgf(decodePng(fixture.png), how));
          unreadable = false;
          reading = scoreReading(expected, actual);

          // Reported, not failed on: a badly misread diagram can put stones where they
          // could not legally stand through no fault of the move logic, so failing here
          // would punish a low score twice.
          const dead = stonesWithoutLiberties(actual);
          if (dead.length > 0) {
            illegal = dead.map((p) => humanCoord(p, actual.boardSize)).join(', ');
          }
        } catch (cause) {
          illegal = (cause as Error).message;
        }

        scored.push({ name: fixture.name, reading, unreadable, illegal });
      }

      current[readerName] = Object.fromEntries(
        scored.map((s) => [s.name, Number(s.reading.score.toFixed(4))]),
      );
      report(readerName, scored);

      const books = scored.filter((s) => !s.name.startsWith(GENERATED));
      const average = books.reduce((total, s) => total + s.reading.score, 0) / books.length;

      const noBoard = scored.filter((s) => s.unreadable);
      const wrongStones = scored.filter((s) => !s.unreadable && s.reading.stones.length > 0);
      const useless = scored.filter((s) => !s.unreadable && s.reading.score < FLOOR);
      const failures: string[] = [];

      if (noBoard.length > 0) {
        failures.push(
          `no board found at all in ${noBoard.length}:\n` +
            noBoard.map((s) => `    ${s.name}: ${s.illegal}`).join('\n'),
        );
      }
      if (wrongStones.length > 0) {
        failures.push(
          `stones wrong in ${wrongStones.length}:\n` +
            wrongStones
              .map((s) => `    ${s.name}: ${s.reading.stones.join(', ')}`)
              .join('\n'),
        );
      }
      if (useless.length > 0) {
        failures.push(
          `read below ${FLOOR}:\n` +
            useless
              .map((s) => `    ${s.name}: ${s.reading.score.toFixed(2)} — ${summarise(s.reading)}`)
              .join('\n'),
        );
      }
      if (average < BOOKS_MUST_AVERAGE[readerName]) {
        failures.push(
          `books average ${average.toFixed(3)}, below ${BOOKS_MUST_AVERAGE[readerName]}`,
        );
      }

      if (failures.length > 0) expect.fail(`${readerName}:\n  ${failures.join('\n  ')}`);
    }, TIMEOUT);
  }

  it('writes the scores back for next time', () => {
    // Last, so every reader has run. Gitignored: it is a readout, not a commitment.
    writeFileSync(SCORES, `${JSON.stringify(current, null, 2)}\n`);
    expect(Object.keys(current).length).toBe(readers.length);
  });

  it('records what any new fixture scored on first sight', () => {
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;

    for (const fixture of fixtures) {
      if (fixture.name.startsWith(GENERATED)) continue;
      // Written once and then left alone. A fixture already here keeps whatever it got the
      // day it arrived, however much has changed since.
      if (firstSight[fixture.name]) continue;

      firstSight[fixture.name] = {
        on: today,
        scores: Object.fromEntries(readers.map(([name]) => [name, current[name]?.[fixture.name] ?? 0])),
      };
      added++;
    }

    if (added > 0) {
      const ordered = Object.fromEntries(Object.entries(firstSight).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(FIRST_SIGHT, `${JSON.stringify(ordered, null, 2)}\n`);
    }

    const witnessed = Object.entries(firstSight).filter(([, s]) => !s.predates);
    if (witnessed.length > 0) {
      const line = readers
        .map(([name]) => {
          const scores = witnessed.map(([, s]) => s.scores?.[name] ?? 0);
          const mean = scores.reduce((t, v) => t + v, 0) / scores.length;
          const perfect = scores.filter((v) => v === 1).length;
          return `${name} ${mean.toFixed(3)} (${perfect}/${scores.length} perfect)`;
        })
        .join('   ');
      console.log(`\non first sight, over ${witnessed.length} fixtures since recording began: ${line}`);
    } else {
      console.log(`\nno fixture has been seen for the first time yet — the ${Object.keys(firstSight).length} in the corpus all predate this`);
    }

    expect(Object.keys(firstSight).length).toBeGreaterThan(0);
  });
});

/** A line or two of what went wrong, for the failure message. */
function summarise(reading: Reading): string {
  const parts: string[] = [];
  if (reading.missing.length > 0) parts.push(`missed ${reading.missing.slice(0, 4).join(', ')}`);
  if (reading.spurious.length > 0) parts.push(`invented ${reading.spurious.slice(0, 4).join(', ')}`);
  return parts.join('; ') || 'nothing to compare';
}

/** Worst first, with how each score moved since the last run. */
function report(
  readerName: string,
  scored: Array<{ name: string; reading: Reading; unreadable: boolean; illegal: string }>,
): void {
  const books = scored.filter((s) => !s.name.startsWith(GENERATED));
  const generated = scored.filter((s) => s.name.startsWith(GENERATED));
  const mean = (rows: typeof scored) =>
    rows.length === 0 ? 1 : rows.reduce((t, s) => t + s.reading.score, 0) / rows.length;

  const lines = [
    '',
    `${readerName}: books ${mean(books).toFixed(3)} (${books.length})   ` +
      `generated ${mean(generated).toFixed(3)} (${generated.length})`,
  ];

  const interesting = [...scored]
    .filter((s) => s.reading.score < 1 || s.illegal)
    .sort((a, b) => a.reading.score - b.reading.score);

  for (const s of interesting) {
    const was = previous[readerName]?.[s.name];
    const moved =
      was === undefined
        ? '  (new)'
        : Math.abs(was - s.reading.score) < 5e-4
          ? ''
          : `  (was ${was.toFixed(3)})`;
    lines.push(
      `  ${s.reading.score.toFixed(3)}  ${s.name}${moved}` +
        (s.unreadable ? `  NO BOARD: ${s.illegal}` : ''),
    );
  }

  if (interesting.length === 0) lines.push('  every fixture read perfectly');

  // Anything that used to be here and is now perfect is worth seeing too.
  const recovered = Object.entries(previous[readerName] ?? {})
    .filter(([name, was]) => was < 1 && (current[readerName][name] ?? 0) >= 1)
    .map(([name]) => name);
  if (recovered.length > 0) lines.push(`  now perfect: ${recovered.join(', ')}`);

  console.log(lines.join('\n'));
}
