// Thin bootstrap wrapper. The pre-existing dashboard server is preserved byte-for-byte
// in server-core.mjs; this preload only adds isolated /api/ai-review* routes.
import "./ai-review-http-hook.mjs";
await import("./server-core.mjs");
