# sgfcap

Turn a photo or scan of a go/baduk position into SGF. Everything runs in the browser —
no server, no upload.

## The app

```
pnpm install
pnpm dev
```

Drop, choose or paste an image and it becomes an editable board. The whole conversion runs
client-side, so `pnpm build` produces a static bundle that can be hosted anywhere.

```
pnpm gh-pages
```

builds and pushes `dist/` to the `gh-pages` branch. GitHub Pages needs pointing at that
branch once, in the repository's Settings → Pages.

Asset URLs are **relative** (`base: './'` in `vite.config.ts`), so the page works from a
repository subpath like `/sgfcap/`, from a domain root, or opened straight off disk. Hard
coding the repository name as the base is the usual approach and breaks the moment the site
moves. `public/.nojekyll` stops Pages running the output through Jekyll, which would
otherwise drop anything beginning with an underscore.

The board is [besogo](https://github.com/yewang/besogo), an embeddable SGF editor — it
provides move navigation, the variation tree, stone placement and SGF download, so the app
itself only has to do intake, conversion and handing over the text.

It opens on the finished diagram, with the move numbers showing. Two things make that work:

- besogo's `path` option walks forward that many nodes and stops when it runs out, so
  passing the move count lands on the last move. (`besogo.create` returns nothing and does
  not expose its editor, so `path` is the only way to set the starting position.)
- besogo has **no** automatic move numbering — the only text it draws on a stone is SGF `LB`
  markup, which it renders white-on-black and black-on-white with the font scaled to the
  label length. So the numbers are written out as `LB` on the last move node.

Two things about how it sizes itself. It measures its parent's width **at creation** and
lays itself out from that, so the result section is revealed before the board is built —
built inside a hidden section it measures nothing, which is a different layout again, and
was why the first board on a fresh page looked unlike every one after it. And the
orientation is pinned to `portrait` rather than left on `auto`, which puts the panels
beside the board on anything wider than 600px; here the diagram is the point, so it gets
the full width and the controls sit under it.

## The core function

```ts
import { imageToSgf } from './src/index.js';

const sgf = await imageToSgf(image); // image: RgbaImage
```

`RgbaImage` is structurally identical to the DOM's `ImageData`, so in the browser you can
pass `ctx.getImageData(...)` directly. It carries no DOM types, which is what lets the same
code run under Node in the tests.

Decoding is the one environment-specific step, so it lives in `src/browser/imageInput.ts`:

```ts
import { fromBlob, imageFromClipboard } from './src/browser/imageInput.js';

const image = await fromBlob(file);              // upload or drop
const blob = imageFromClipboard(event);          // paste; null if no image on the clipboard
```

`analyzeImage(image)` returns the same reading as a `BoardAnalysis` — detected grid lines,
the inferred board region, and a per-intersection call with confidence. `imageToSgf` is a
thin wrapper over it. Reach for it when a fixture fails and you need to know why.

Board size and the crop's position on the board are both detected. A diagram showing both
edges of an axis has counted the board — 19, 13 or 9 — and one that shows neither is taken
for a 19, since a cropped corner of a 19 and of a 13 are the same picture.

## Tests

```
pnpm test
```

Every `test/data/<name>.png` is run through `imageToSgf` and **scored** against
`test/data/<name>.sgf`, from 0 to 1. Adding a case means dropping in those two files — no
test code changes, and no obligation to make it pass the day it arrives.

The score is the share of a diagram's *claims* that survive the round trip:

```
matched / (expected ∪ actual)
```

A claim is one printed thing — a stone as `(point, colour)`, a move as `(point, number)`, a
letter, a mark. Taking the union means an invented stone costs the same as a missed one, and
counting claims rather than intersections stops the three hundred empty points of a sparse
diagram drowning the twenty that carry something.

Reading thirty-four of a book's thirty-five numbers is not the same failure as not finding
the board, and a suite that treats them alike forces every new image to be fixed or deleted
the day it arrives — which is how the interesting images get thrown away. So the run fails
on four things only:

- a diagram that produces **no board at all**
- a diagram with **any stone wrong**, missing or invented
- any diagram below **0.5**, which is not a reading
- the **books** averaging below 0.97

Stones are held to a different standard from everything else. A misread number is one claim
among many and the score says so; a stone missing or invented is the *position* being wrong,
and a wrong position is not a reading of that diagram at all, however well the rest came out.

Generated fixtures are averaged apart from the books, since they are curated to pass and
would otherwise inflate
the number as more are added.

Deliberately **not** a ratchet on individual scores: locking each fixture where it stands
makes every small change a negotiation. Instead the run writes `.fixture-scores.json` and
prints how each score moved since the last run — `0.871 itb-01 (was 1.000)`, or
`now perfect: otme-01` — so drift is visible without gating on it.

The reading also has to be **legal** — no stone left standing without liberties. That is
reported rather than failed on, since a badly misread diagram can produce an illegal
sequence through no fault of the move logic.

On failure the message names what was missed and what was invented
(`missed move qd 4; invented move qd 1`), which is usually the bug.

### Fixtures

`test/data/synthetic-fullboard.png` is machine-generated from its own SGF:

```
pnpm fixture test/data/some-position.sgf
```

Clean synthetic boards are the easy end of the range — a first target for the detector.
Real book scans get added by hand, image and expected SGF together.

Fixture images must be PNG; Node decodes them with `pngjs`, which has no JPEG support.
Adding JPEG means adding a decoder in `test/helpers/png.ts` — the browser side already
handles any format canvas can read.

### Generated fixtures

```
pnpm generate --count 40      # random diagrams into test/data/generated
pnpm faces                    # which installed typefaces the reader can read
```

Random positions, drawn in real typefaces, cropped at every corner and edge, at sizes from
25 to 40 pixels a cell, then tilted or blurred or resampled or noised. They fill in what
thirty-five books happen not to cover: every crop, every size, and twenty-one faces instead
of a dozen.

Two rules keep them honest.

**Nothing is ever captured.** Every group is left two liberties in the finished position,
and since every earlier position is a subset of it, no earlier group can have fewer. So the
move order is free to choose, and the picture the renderer draws is the board the SGF says.

**A fixture is only kept if the reader already reads it.** A generated diagram that fails is
either a gap already known — a face nothing has taught it — or a bug, and a bug wants fixing
rather than committing as a permanently red test. So the run prints its rejects with reasons,
and *those* are the interesting output: about a third of random diagrams are refused, and
working through why is what the last few detector fixes came out of.

They are also what every model here learns from — see *Retraining* below.

Drawing them needs fonts, which the renderer takes through a small interface so that
`opentype.js` stays in `scripts/` and out of the browser bundle:

```
sudo apt-get install -y fonts-dejavu-core fonts-liberation2 fonts-urw-base35
```

With none installed it falls back to the built-in stroke font in `src/strokeFont.ts`, which
also draws the four SGF marks — those are not text and no typeface has them.

### Training data

```
pnpm dataset --count 2500     # labelled glyphs into dataset/
```

Groundwork for replacing glyph recognition with a classifier. Writes `glyphs.bin` (24x24
bytes a sample), `glyphs.tsv` (label, source, and the size it was printed at) and
`preview.png`, a contact sheet to look at before trusting any of it. Regenerable, so it is
not committed.

Three things it does on purpose.

**Glyphs are cut out by the reader's own code**, not drawn in isolation. A classifier trained
on clean characters would meet none of what actually arrives: a piece of the stone's outline
fused to a digit, a number clipped by a tight crop, a stroke broken by a photocopier.

**Proportions are kept.** Samples are scaled into a 24x24 square keeping their aspect, so a
narrow `1` stays narrow and a circle stays round.

**A quarter of the set is `nothing`** — line crossings, board corners, star points, plain
stones, and two-digit numbers fused into a single shape. That class matters as much as the
characters: answering *is there a character here at all* used to take a pile of hand-written
rules, and a classifier that has been shown the alternatives answers it from evidence.

The letters run the whole alphabet in both cases, far wider than books print, because the
generator can draw them in fifty typefaces at no cost and a classifier that has only seen
`a` to `f` has learned six shapes rather than what letters look like. Each sample records
whether it came from a book or was drawn, so the books can be held back.

## How detection works

Five stages, in `src/detect/`:

1. **`binarize.ts`** — luminance, then an Otsu threshold picked per image, so grey scans
   separate as well as clean renders do.

   A printed diagram is often **three** things, though: paper, the ink of the stones, and a
   grid drawn grey between them. Otsu splits an image in two and has to put the grey on one
   side or the other. With the paper, the grid vanishes from the mask — in
   `2026-08-13_17-22` the lines sit at 164 against a cutoff of 141, and all that survives is
   the crossings, where two lines overlap and darken enough to fall the other way. With the
   ink, every white stone turns black.

   So there are two masks. Otsu run a second time over the lighter class alone finds the
   grey, if there is any — guarded, because a page with nothing between its ink and its
   paper still yields *some* split, and because paper is the most common thing on a page:
   a board rendered on tan otherwise has its stones as the lighter minority, and the whole
   board becomes ink.

   Which mask the grid wants **cannot be told from the histogram**. The grey band in
   `opening-01` looks just like the one in `2026-08-13_17-22` and is not a grid at all —
   it is the antialiasing around the stones, and taking it thickens everything until no
   board can be found. So both are tried and the one that finds more of a board wins.
   Everything after the grid reads from the ordinary mask.
2. **`deskew.ts`** — a page scanned at an angle is straightened first, because everything
   below assumes the board is square to the image: the grid is found by summing ink down
   columns, and a degree of tilt smears each line across several of them. The angle is found
   by trying rotations and keeping the one whose projections are sharpest — a line square to
   an axis drops all its ink in one bin. An image already straight is left untouched, since
   resampling costs sharpness.
3. **`grid.ts`** — ink is summed down each column and across each row; board lines are long
   and axis-aligned, so every line shows up as a spike. Those positions are then fitted to a
   lattice, `origin + i * spacing`.

   How tall a spike has to be is measured against a **typical** line, not the tallest one.
   The tallest is usually not a line at all: a board's outer border is drawn heavier than
   its grid and runs the full width of the diagram. Meanwhile a white stone is a hole with
   an outline, so a row of them erases the line beneath it. Put together, an interior line
   can carry a third of the border's ink and still be a line — in `2026-08-12_22-56_1` the
   strongest peaks are 7 of the 11 rows, and the lattice fitted through them is nonsense.

   Cutting lower is not free, though: on a crowded full-board scan it also admits the bands
   of ink across a cluster of numbered stones. And a projection is taken over the whole
   picture, so **anything else on the page lands in it too** — a caption under the diagram,
   a line of body text a screenshot happened to catch.

   So neither reading is trusted as it stands. Each is reduced to the peaks that sit on one
   **evenly spaced lattice**, and whichever is left with more lines wins. Even spacing is
   the one thing a grid does and stray ink does not, and it is the only property here that
   does not depend on how dark anything is. Every pair of peaks proposes a spacing — theirs,
   and theirs divided by two, three and four, in case the lines between went unseen — and
   the proposal that accounts for most of the board wins.

   Two rules stop a spacing winning by being fine enough to cover everything. A lattice
   needing more than 19 points is refused. And what is scored is not how many peaks are
   explained but that count *less the lattice positions left empty*, so halving the spacing
   has to find a peak at every new position it invents to break even. Without the second, a
   diagram cropped to eight lines gets read at half spacing across fifteen, which picks up
   one stray peak and shifts every stone by half a point.

   Not every line has to be found. A photocopied diagram loses faint lines outright, so the
   gaps between the lines that *were* found are read as near-multiples of one spacing, each
   line given a lattice index, and the missing ones interpolated. Demanding all 19 spikes
   rejects real book scans.

   A side effect worth knowing: fitting to a lattice tolerates about a quarter of a spacing
   of drift, so a degree or two of tilt no longer defeats the grid on its own. Deskewing
   still earns its place above two degrees, and everything downstream still wants the board
   square.

   Nor does the whole board have to be in view. A diagram cropped to a corner is **placed**
   by looking just outside its outermost lines: past the board's own edge nothing continues,
   while at a crop the perpendicular lines run on to the edge of the picture. That strip
   has to start clear of the outermost line and stop short of the coordinates,
   and both ends of that window are pinned by real diagrams: a border can be four or five
   pixels thick with the fitted line at its centre at best, so starting too close reads the
   border's own ink, while coordinate labels sit about three quarters of a spacing out.

   What is counted there is **how many perpendicular lines carry on**, not how much ink is
   present. Plenty of things sit in a board's margin without continuing anything: stones
   played on the edge bulge past it, reference letters are printed outside it, a caption
   puts a whole line of type there. Measured over every fixture, both ends of both axes,
   against the answer each one's own SGF demands, a real cut carries at least 0.82 of the
   perpendicular lines and almost always all of them, while a board edge reaches 0.50 at
   worst — three stones and a letter overhanging the top row of `has-label`.

   A crop with neither edge of the board in view is refused rather than guessed at, since
   nothing in the picture says which part of the board it is.
4. **`stones.ts`** — per intersection, two measurements. Ink around the stone's edge says
   whether a stone is there at all: black stones are solid to their rim and white ones are
   drawn with an outline, while an empty point has only two thin lines crossing. Ink in the
   band between the printed number and that edge then says which colour, because a black
   stone is solid there and a white one is bare.

   Neither looks at the grid lines. Judging a stone by whether it hides the lines beneath it
   fails exactly where diagrams are hardest: in a dense ladder the test lands on the
   neighbouring stones, and white stones read as empty points.

   The lines are still measured, for the letter reader below, and that measure counts out
   of the four a point in the middle of the board has — never out of however many this
   point happens to have. Otherwise the same scrap of leftover line reads higher the nearer
   the edge you get, a quarter in the middle against a half in the corner, and no threshold
   fits everywhere at once.
5. **`digits.ts`** — books mark a played stone by printing its move number on it, in the
   opposite colour, so the glyphs are whatever ink inside the stone is not the stone's own
   fill. Those are split into connected components, cropped, normalised to a 12x16 grid and
   matched against several prototypes per digit.

   Three things make this survive bad scans. Sampling reaches close to the stone's edge, since
   some books print numbers that nearly fill the stone and clipping one distorts it into
   another digit — the stone's own outline, which that lets in, is rejected by its ink
   averaging over 0.9 of the sampling radius where a digit averages under 0.6. And a digit
   that has come apart in printing is put back together: pieces sharing columns are one
   digit, since the digits of a two-digit number never overlap. And where a number is set
   tight enough that its digits touch, the merged piece is cut apart — candidate cuts are
   tried lightest-column first and the one whose **both halves read as digits** is taken.
   Letting recognition choose the segmentation matters: the lightest column is often wrong
   where the bowls of a 3 and a 0 overlap.

   A number set large on a white stone also touches the stone's own outline, and the two
   then come away as one shape. White stones are therefore read inside their own fitted
   circle — the largest circle that is almost all ink — which also absorbs the pixel or two
   by which a scanned stone misses the lattice. Black stones are not fitted: adjacent ones
   merge into a single mass with no boundary to find, and the fit wanders onto a neighbour.

   Two rules keep the **1** honest, and both exist because normalising throws away
   proportions — which for a 1 is the whole character. Stretched to fill the grid, a bare
   stroke becomes a near-solid block, and so does any lump of ink, so the 1 prototypes are
   the ones a smudge lands on. A glyph broader than 0.65 therefore cannot be a 1 whatever it
   scores (a printed one measures 0.08 to 0.57 across the fixtures), and a piece produced by
   cutting a glyph up may not fall back on merely *being* narrow, since a cut makes narrow
   pieces whatever it went through. Without them, a 2 fused to its stone's outline read as
   "11", and every way of halving that blob agreed.

   The cut threshold has to sit clear of the widest real digit rather than near it, because
   a cut is preferred over reading the piece whole — a merged pair does sometimes resemble a
   single digit, so trying whole-first was measured and lost four fixtures. Everything above
   the line gets chopped, so a 4 at 0.86 with the line at 0.85 came back as "44". Measured on
   the widest crop of every labelled stone, one digit reaches 0.86 and a fused pair starts at
   1.00; the line sits between.

   A numbered stone becomes a **move**, not a labelled setup stone. Books print the stone a
   sequence captures — `litfog-02` shows a white stone whose last liberty the fifth move
   fills — so recording every stone as setup produces a board that cannot legally exist and
   that no editor will let you play from. Replaying the moves lifts it.

   The number as printed is carried on the move and written out as `LB` markup, rather than
   regenerated from the move's index: a continuation diagram numbers its moves 11-20 while
   they are still that diagram's 1st to 10th moves, and the page's own numbering is what the
   board should show.

   Naming a glyph is a small convolutional net — `classify.ts` — trained on diagrams the
   generator draws, never on the fixtures. `digits.ts` finds the ink, groups it into
   characters and cuts a fused number apart; naming what it cut is the net's job, and the
   split matters: the first part is geometry and holds for any diagram, the second is
   recognition and is learned.

   Stones can also carry a **triangle** instead of a number — how a book says "the marked
   stone". It is the same ink in the same place, so it comes off the stone the same way and
   is read as a shape rather than a character, becoming `TR` in the SGF. All four SGF marks
   are drawn by the generator and recognised.

   A stone carries one or the other, and **the shape is asked about first**. A triangle is
   wider than it is tall, which is precisely the signal the number reader takes as licence
   to cut a glyph into separate digits — let it go first and a triangle comes back as
   "221", with the mark never looked for at all.

   Empty points can carry a **letter** for the prose to refer to, printed in place of the
   grid lines, which are erased around it. Those are read the same way but told apart by
   context — a stone is numbered and a bare point is lettered — which removes the confusions
   that bite hardest at this size: 6 against b, 9 against g, 0 against o.

   A letter is only looked for where something is actually printed, and **that gate is
   load-bearing**. Offered every empty point, the reader accepts 435 of them across the
   fixtures: board edges, where the border's L and T shapes read as `b`, `c`, `d` or `f`,
   and star points, whose dot and stubs of line read as `f`. Deciding it used to be one
   threshold on how much grid line survives; it is a second small net now — `gate.ts` — and
   on sources held out of its training it invents nothing and misses nothing.

   Neither the numbers nor the letters are read one at a time and left at that. A diagram's
   move numbers form a contiguous run whose colours strictly alternate, and its letters form
   a run used once each — so `sequence.ts` and `letters.ts` reconcile the readings against
   those constraints, which settles cases no single glyph can.

Each intersection carries a confidence derived from its distance to the decision boundary,
so marginal calls are visible in `analyzeImage` output instead of silently reading as certain.

## State

19x19, 13x13 and 9x9 boards are handled, whole or cropped to a corner or an edge, straight
or a degree or two off. A board showing both edges of an axis has counted itself; a count
that is not one of the three sizes is rejected with `SgfCaptureError` rather than guessed
at, since both edges in view and fifteen lines between them is a misjudged edge and not a
fifteen by fifteen board.

Everything that names what it sees — the glyph reader, the print gate, the stone reader — is
trained on diagrams the generator draws and never on the fixtures. The books are used twice
and never for learning: those outside the held-out sources choose which epoch to keep, and
the held-out ones are not looked at until the end.

That is the whole bet, and it is what a corpus cannot do for itself. A book that letters its
points `A` to `F` in capitals, or marks a stone with a square, is unreadable to anything that
learned its shapes from fixtures that happen to contain neither — while a generator can be
asked for both.

Letters are recognised for `a` to `f`, plus `A` and `B` — the ones a diagram has actually printed. Anything
further reads as nothing rather than as a wrong letter, which is the safe failure; the fix is
to add the prototype.

Cropped diagrams are placed by which board edges are in view, so corners and edges work;
a crop showing neither edge is refused. Dense diagrams work too: `litfog-04` is a double
ladder of 37 numbered moves with stones touching on every side.

Known gaps. Deskew corrects a **rotation**, not perspective or a shear — a photographed page
that curves will need more than an angle. A **centre crop cannot be placed**, since nothing
in the picture says where it belongs.

And **binarisation is still mostly global**. One Otsu threshold for the whole page cannot
serve two questions at once — which pixels are the page's ink, and which pixels inside a
black stone are the number printed on it. Black stones now get their insides re-thresholded
against themselves (`localizeStones`), guarded so that a plain stone's flat tone cannot be
split into an imaginary digit, and a second cut separates the number from the specular
highlight on a glossy stone. Everything else on the page still runs on one cutoff, and the
hard images are the ones where that cutoff has to be wrong somewhere: a grid drawn in the
same grey as a white stone's rim, a board on wood where nothing is ink at all.

**Italics are not read.** Of the fifty-one typefaces installed here, `pnpm faces` says
twenty-one are read perfectly and the thirty that are not are almost exactly the italics,
the obliques and the monospaces. Nothing has taught the reader a slanted numeral, because no
book in the corpus prints one. The fix is a book that does, not a font that does.

**Letters and marks are thin in the corpus.** One `f`, three `e`, five `c`, five triangles,
a single `A` and `B` — most from one book each, against eighty `1`s and seventy `2`s from a
dozen books. That is a limit on what the fixtures can *measure*, not on what the reader can
learn: the generator draws the whole alphabet in every typeface installed, and all four marks.

## Adding a book

```
pnpm test
```

Drop the image and its expected SGF into `test/data/` and run the suite. Nothing is
regenerated and no model is retrained — a new book is evidence, not training data.

The suite records what it scored **the first time it ever read it**, in
`test/first-sight.json`, and never touches that number again. It is the only unbiased
measurement the corpus can produce: every other number here is measured against images the
thresholds were tuned with in view, so they say how well the reader fits what it has already
been shown. A fixture's first reading is the one time it is unseen data.

## Retraining

```
pnpm dataset --count 2500   # draw diagrams, cut them into labelled glyphs
pnpm train                  # -> src/detect/weights.ts
pnpm patches --count 500    # draw diagrams, cut them into labelled intersections
pnpm train-gate             # -> src/detect/gateWeights.ts   is anything printed here
pnpm train-stones           # -> src/detect/stoneWeights.ts  empty, black or white
```

**No fixture is ever trained on.** Training is drawn diagrams; the books are used twice and
never for learning — those outside the held-out sources choose which epoch to keep, and the
held-out ones are not looked at until the end. The split is by *source*, not by sample:
every point of one diagram shares a typeface, a printing and a scanner, so holding out a
tenth of the points would score astonishingly well by recognising the page.

**Held-out glyph accuracy is the number to judge a reader change by, not the fixture count.**
Retraining at identical settings swings how many fixtures come out perfect by about five,
which is larger than most changes are worth — so anything tuned on that number is tuned on
noise. Measured against a control, sampling diagrams down to a smaller size is worth two and
a half points of held-out accuracy; the fixture count could not see it at all.

**When a fixture fails, the fix is usually in the generator.** Every hard failure of the last
stretch was a case the generator had never drawn: a board on wood rather than white paper,
a glossy stone with a highlight across its shoulder, a diagram sampled down to a lower
resolution. The corpus cannot teach what it does not contain, so a real failure becomes a
new axis for the generator to vary — not a new threshold.
