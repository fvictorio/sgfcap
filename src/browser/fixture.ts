import { SgfCaptureError } from '../types.js';
import { zip } from './zip.js';

/**
 * Saving a reading as a test fixture, so that using the app is how the corpus grows.
 *
 * A fixture is a pair — the image, and the SGF of what that image actually says — under one
 * name, which is what `test/data` is made of. Collecting them by hand meant saving the image
 * somewhere, copying the SGF, pairing them up and naming both, and the corpus grew at the
 * rate that chore got done.
 *
 * The SGF written here is the board **as it stands in the editor**, not the reading that came
 * out of the image. That distinction is the whole point. A fixture records what the diagram
 * says, so that the reader can be measured against it; saving what the reader replied would
 * produce a test that passes by construction and measures nothing. Correct the board first,
 * then save.
 */

/**
 * A name that sorts, and says when.
 *
 * The corpus already names its scans this way, and a timestamp beats a random string on every
 * count that matters here: two captures cannot collide, they file themselves in order, and
 * when a fixture starts failing you can tell how old it is.
 */
export function fixtureName(when = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = [when.getFullYear(), pad(when.getMonth() + 1), pad(when.getDate())].join('-');
  const time = [pad(when.getHours()), pad(when.getMinutes()), pad(when.getSeconds())].join('-');
  return `${date}_${time}`;
}

/** The image and the SGF under one name, ready to unzip straight into `test/data`. */
export async function fixtureArchive(
  image: Blob,
  sgf: string,
  when = new Date(),
): Promise<{ name: string; archive: Blob }> {
  const name = fixtureName(when);
  const text = sgf.endsWith('\n') ? sgf : `${sgf}\n`;

  const archive = zip(
    [
      { name: `${name}.png`, bytes: await pngBytes(image) },
      { name: `${name}.sgf`, bytes: new TextEncoder().encode(text) },
    ],
    when,
  );

  return { name, archive };
}

/**
 * The image as PNG bytes.
 *
 * Handed straight through when it already is one, which is the common case and keeps the
 * fixture byte-identical to what was read. Anything else — a JPEG screenshot, a paste out of a
 * PDF viewer — goes through a canvas. That is lossless from here on: whatever the original
 * format did to the picture is already in the pixels, and those pixels are what the reader
 * saw, so the fixture stays an honest record of the image that produced the reading.
 */
async function pngBytes(image: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (image.type === 'image/png') return new Uint8Array(await image.arrayBuffer());

  const bitmap = await createImageBitmap(image);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  try {
    const context = canvas.getContext('2d');
    if (!context) throw new SgfCaptureError('Could not get a 2D canvas context to save the image.');
    context.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }

  const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!encoded) throw new SgfCaptureError('Could not re-encode the image as a PNG.');

  return new Uint8Array(await encoded.arrayBuffer());
}

/** Hand a blob to the browser as a download. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  // Long enough for the browser to have taken the download off the URL. Revoking straight
  // away races it, and in Firefox the download arrives empty.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
