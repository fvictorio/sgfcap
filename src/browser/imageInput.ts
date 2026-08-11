import { SgfCaptureError, type RgbaImage } from '../types.js';

/**
 * Browser-only adapters that turn whatever the user hands the app into `RgbaImage`.
 *
 * Decoding is the one genuinely environment-specific step, so it is quarantined here.
 * Nothing else in `src/` touches the DOM, which is what keeps the core testable in Node.
 */

/** Decode an uploaded or dropped file. */
export async function fromBlob(blob: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    return drawToPixels(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Find the image on a paste, if there is one. Returns null when the clipboard held
 * something else, so callers can fall through to their normal paste handling.
 *
 * This hands back the blob rather than decoded pixels because callers generally want
 * the original too — to show it next to the result — and decoding it twice would be
 * wasteful. Pass it to `fromBlob` when you need the pixels.
 */
export function imageFromClipboard(event: ClipboardEvent): Blob | null {
  const items = event.clipboardData?.items;
  if (!items) return null;

  // DataTransferItemList is array-like but not iterable.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;

    const file = item.getAsFile();
    if (file) return file;
  }

  return null;
}

function drawToPixels(source: CanvasImageSource, width: number, height: number): RgbaImage {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  // Reading back every pixel is the whole point here, so opt out of GPU-side storage.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new SgfCaptureError('Could not get a 2D canvas context to decode the image.');

  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, width, height);
}
