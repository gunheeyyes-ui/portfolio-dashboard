// Thin bootstrap wrapper. Existing home-entry logic remains byte-for-byte in
// index-entry-review-core.js; the AI layer only observes the rendered candidates.
import "./home-ai-review.js";
await import("./index-entry-review-core.js");
