declare module '*.css';

/** besogo ships as an IIFE that hangs itself off `window`, with no module exports. */
declare module 'besogo/besogo.all.js';

/** Opaque: besogo's editor object, which it never names in its API. */
interface BesogoEditor {
  [key: string]: unknown;
}

interface Window {
  besogo: {
    /** Returns nothing — the editor object is not exposed, so `path` is the only way in. */
    create(container: HTMLElement, options: Record<string, string | number | boolean>): void;
    /** Serializes an editor's whole game tree back to SGF. */
    composeSgf(editor: BesogoEditor): string;
    /** Builds the navigation panel. Called with the editor, which is how we get hold of it. */
    makeControlPanel(container: HTMLElement, editor: BesogoEditor): void;
  };
}
