import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { RgbaImage } from '../../src/types.js';

/**
 * PNG codec for the tests only.
 *
 * The browser decodes with canvas (see `src/browser/imageInput.ts`); pngjs exists so
 * Node can read fixtures without a headless browser. It is a devDependency and never
 * reaches the app bundle.
 */

export function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data),
  };
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

export function writePng(path: string, image: RgbaImage): void {
  writeFileSync(path, encodePng(image));
}
