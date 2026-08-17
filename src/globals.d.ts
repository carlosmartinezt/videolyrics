/**
 * `letterSpacing` on a 2D context is Chrome 99+ and Safari 17+, and is how the
 * renderer tracks type. TypeScript's DOM lib has not always carried it, so it
 * is declared here rather than being cast away at every call site.
 */
interface CanvasRenderingContext2D {
  letterSpacing: string;
}
