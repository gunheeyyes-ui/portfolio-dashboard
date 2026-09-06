// Thin bootstrap wrapper. Existing home-entry logic remains byte-for-byte in
// index-entry-review-core.js; display-only observers add freshness and AI review.
import "./home-candidate-freshness.js";
import "./home-ai-review.js";
import "./home-ai-review-inline.js";
await import("./index-entry-review-core.js");
