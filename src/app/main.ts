import 'besogo/besogo.all.js';
import 'besogo/css/besogo.css';
import 'besogo/css/board-flat.css';
import './style.css';

import { download, fixtureArchive } from '../browser/fixture.js';
import { fromBlob, imageFromClipboard } from '../browser/imageInput.js';
import { imageToSgf } from '../imageToSgf.js';
import { parseSgf } from '../sgf.js';

const intake = element<HTMLElement>('intake');
const dropzone = element<HTMLLabelElement>('dropzone');
const fileInput = element<HTMLInputElement>('file');
const status = element<HTMLParagraphElement>('status');
const errorMessage = element<HTMLParagraphElement>('error');
const errorDetail = element<HTMLSpanElement>('error-detail');
const errorOffer = element<HTMLSpanElement>('error-offer');
const result = element<HTMLElement>('result');
const board = element<HTMLDivElement>('board');
const source = element<HTMLImageElement>('source');
const reset = element<HTMLButtonElement>('reset');
const copy = element<HTMLButtonElement>('copy');

/**
 * besogo's editor, once we have got hold of it.
 *
 * `besogo.create` returns nothing and stores its editor privately, but it hands that
 * editor to every panel it builds — so wrapping a panel maker for the length of the call
 * catches it. Worth the trick: with the editor, Copy exports the board as it stands,
 * including anything played on it since, rather than the text we first read out of the
 * image.
 */
let editor: BesogoEditor | null = null;

/** The reading as first converted — what Copy falls back to if the editor eludes us. */
let currentSgf = '';

/** Held so it can be revoked when the next image replaces it. */
let sourceUrl: string | null = null;

/** The image this reading came from, kept so it can be saved beside the corrected board. */
let sourceBlob: Blob | null = null;

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void convert(file);
});

// Paste works anywhere on the page — it is the fastest route in from a PDF or a
// screenshot tool, and demanding focus on a particular element would only get in the way.
document.addEventListener('paste', (event) => {
  const blob = imageFromClipboard(event);
  if (!blob) return;

  event.preventDefault();
  void convert(blob);
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}

for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('is-dragging'));
}

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file?.type.startsWith('image/')) void convert(file);
});

copy.addEventListener('click', () => {
  void (async () => {
    const sgf = editor ? window.besogo.composeSgf(editor) : currentSgf;

    try {
      await navigator.clipboard.writeText(sgf);
      confirmCopy();
    } catch {
      // Clipboard access needs a secure context and, in some browsers, permission. Nothing
      // to do with the diagram, so this one does not ask for it.
      showProblem('Could not reach the clipboard — your browser did not allow it.', {
        offer: false,
      });
    }
  })();
});

function confirmCopy(): void {
  copy.textContent = 'Copied';
  copy.dataset.done = 'true';

  window.setTimeout(() => {
    copy.textContent = 'Copy SGF';
    delete copy.dataset.done;
  }, 1500);
}

reset.addEventListener('click', () => {
  result.hidden = true;
  intake.hidden = false;
  errorMessage.hidden = true;
  fileInput.value = '';

  // Drop the old image rather than leaving it to flash up behind the next one.
  board.replaceChildren();
  source.removeAttribute('src');
  sourceBlob = null;
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
});

async function convert(blob: Blob): Promise<void> {
  errorMessage.hidden = true;
  show(status, 'Reading the diagram…');

  try {
    const image = await fromBlob(blob);
    const sgf = await imageToSgf(image);
    showBoard(sgf, blob);
  } catch (cause) {
    showError(cause);
  } finally {
    status.hidden = true;
  }
}

function showBoard(sgf: string, blob: Blob): void {
  // Reveal before building the board. besogo sizes itself from its parent's width at
  // creation and picks its own layout from that, so building it inside a hidden section
  // measures nothing — the reading that produced the first board on a fresh page, but not
  // the second, which measured a real width and rearranged itself around it.
  intake.hidden = true;
  result.hidden = false;

  // besogo reads the SGF out of its container's text content, and takes the container
  // over entirely — so it gets a fresh child each time rather than being reused.
  //
  // The container keeps a wrapper of its own that is never unparented. besogo registers a
  // window resize handler per board and never lets it go; that handler reads the parent's
  // width, and reading it off nothing at all throws. Leaving the old board attached to
  // something it no longer shows in costs one empty div and keeps every stale handler quiet.
  const container = document.createElement('div');
  container.textContent = sgf;
  const host = document.createElement('div');
  host.append(container);
  board.replaceChildren(host);

  editor = null;
  currentSgf = sgf;

  const makeControlPanel = window.besogo.makeControlPanel;
  window.besogo.makeControlPanel = (panel, created) => {
    editor = created;
    makeControlPanel(panel, created);
  };

  try {
    window.besogo.create(container, {
      // 'control' has to stay in this list: it is the panel we borrow to catch the editor.
      panels: 'control+tool+tree+file',
      coord: 'western',
      resize: 'auto',
      // Say which way round it goes rather than letting it decide. Left to itself besogo
      // puts the panels beside the board on anything wider than 600px, which is most
      // screens, and the board gets whatever is left. Here the diagram is the point, so it
      // takes the full width and the controls sit under it.
      orient: 'portrait',
      // Portrait height as a percentage of the width, and deliberately not a number: that
      // is besogo's own route to leaving the overall height alone, so the board is sized
      // and the controls below it keep their natural height. Any real ratio here pins them
      // to at least 400px whether they need it or not — the default of 200% gives them as
      // much room again as the board.
      portratio: 'none',
      // Open on the finished diagram rather than the bare setup. besogo walks forward this
      // many nodes and stops when it runs out, so the move count lands exactly on the end.
      path: String(parseSgf(sgf).moves.length),
    });
  } finally {
    window.besogo.makeControlPanel = makeControlPanel;
  }

  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(blob);
  source.src = sourceUrl;
  sourceBlob = blob;
}

/**
 * Say that the image could not be read, and ask for it.
 *
 * One message for every way it can fail, because the ways it can fail are not things anyone
 * outside this repository can act on: "Found only 3 y lines, too few to read a board from" is
 * a note to whoever is fixing the detector, and to the person holding the diagram it is only
 * a more confusing way of saying no. What they can usefully do is send the picture, since a
 * diagram that ought to read and does not is worth more to this project than any other kind
 * of feedback — so that is what the message asks for.
 *
 * The real reason goes to the console, where it is still to hand for anyone debugging a
 * report, and costs the person reading the page nothing.
 */
function showError(cause: unknown): void {
  console.error('sgfcap could not read the image:', cause);

  showProblem("Sorry, I couldn't read a go diagram out of that image.", { offer: true });
  fileInput.value = '';
}

/** `offer` asks for the image, which only makes sense when the image is what went wrong. */
function showProblem(message: string, { offer }: { offer: boolean }): void {
  errorDetail.textContent = message;
  errorOffer.hidden = !offer;
  errorMessage.hidden = false;
}

/**
 * Save the diagram as a test fixture: Ctrl+P, or Cmd+P on a Mac.
 *
 * Undocumented on purpose — this is for growing `test/data`, not for the people the app is
 * for. Print is the shortcut it takes over because a page of one board and one photograph is
 * not a thing anybody prints, and it is the only comfortable chord left.
 *
 * What comes out is the board **as it stands**, so correcting the reading before saving is
 * the point rather than a nicety. A fixture is meant to say what the diagram says; one that
 * merely repeats what the reader replied would pass its own test on the day it was made and
 * measure nothing thereafter.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'p' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (result.hidden || !sourceBlob) return;

  event.preventDefault();
  const image = sourceBlob;

  void (async () => {
    try {
      const sgf = editor ? window.besogo.composeSgf(editor) : currentSgf;
      const { name, archive } = await fixtureArchive(image, sgf);
      download(archive, `${name}.zip`);
      show(status, `Saved ${name}.zip — unzip into test/data.`);
      window.setTimeout(() => (status.hidden = true), 4000);
    } catch (cause) {
      console.error('sgfcap could not save the fixture:', cause);
      showProblem('Could not save the fixture — see the console.', { offer: false });
    }
  })();
});

function show(target: HTMLElement, message: string): void {
  target.textContent = message;
  target.hidden = false;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id} in index.html`);
  return found as T;
}
