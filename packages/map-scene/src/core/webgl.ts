export type WebGLSupport = { supported: true; version: 1 | 2 } | { supported: false; reason: string };

/**
 * Detects WebGL without keeping a context alive. Never throws: privacy
 * settings, blocklisted drivers, headless browsers and old devices can all
 * fail context creation, and the app must fall back to the DOM view.
 */
export function detectWebGL(doc: Document | undefined = typeof document === "undefined" ? undefined : document): WebGLSupport {
  if (!doc) return { supported: false, reason: "no document (server render)" };
  try {
    const canvas = doc.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    if (gl2) {
      gl2.getExtension("WEBGL_lose_context")?.loseContext();
      return { supported: true, version: 2 };
    }
    const gl1 = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    if (gl1) {
      (gl1 as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
      return { supported: true, version: 1 };
    }
    return { supported: false, reason: "WebGL context could not be created" };
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : "WebGL detection failed" };
  }
}
