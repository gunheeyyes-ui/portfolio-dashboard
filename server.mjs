// Thin bootstrap wrapper. The pre-existing dashboard server is preserved byte-for-byte
// in server-core.mjs; these preloads only add isolated extension routes.
import "./ai-review-http-hook.mjs";
import "./paper-auto-http-hook.mjs";
await import("./server-core.mjs");