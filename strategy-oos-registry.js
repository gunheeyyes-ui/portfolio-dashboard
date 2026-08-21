// Single source of truth lives under public/ so both Node and browser views
// import the exact same 94 strategy definitions.
export * from "./public/strategy-oos-registry.js";

// OOS definition identity. The tracker already persists STRATEGY_OOS_SCHEMA on
// every universe row, selection, state and summary, so embedding the registry
// identity here prevents future strategy-definition changes from silently
// looking like the same experiment. Bump the definition version whenever the
// intended interpretation changes. The hash is the canonical LF-normalized Git
// blob SHA-1 of public/strategy-oos-registry.js and is test-locked.
export const STRATEGY_DEFINITION_VERSION = 1;
export const STRATEGY_REGISTRY_HASH = "ecd781bca1b696b0cb665ba2e43e497f2f916050";
export const STRATEGY_OOS_SCHEMA = `strategy-oos-1-def${STRATEGY_DEFINITION_VERSION}-${STRATEGY_REGISTRY_HASH.slice(0, 12)}`;
