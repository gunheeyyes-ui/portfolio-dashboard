// Browser candidate counts stay anchored to the exact 94 base definitions in
// public/strategy-oos-registry.js. Node OOS validation extends that immutable
// base with derived consensus cohorts, without feeding those derived cohorts
// back into the base match count.
export * from "./public/strategy-oos-registry.js";

import {
  FEATURED_STRATEGY_IDS as BASE_FEATURED_STRATEGY_IDS,
  STRATEGY_GROUPS as BASE_STRATEGY_GROUPS,
  STRATEGY_REGISTRY as PUBLIC_BASE_STRATEGY_REGISTRY
} from "./public/strategy-oos-registry.js";
import {
  CONSENSUS_DEFINITION_VERSION,
  CONSENSUS_FEATURED_STRATEGY_IDS,
  CONSENSUS_STRATEGIES,
  CONSENSUS_STRATEGY_GROUP
} from "./public/strategy-consensus-cohorts.js";

export { CONSENSUS_DEFINITION_VERSION };
export const BASE_STRATEGY_REGISTRY = PUBLIC_BASE_STRATEGY_REGISTRY;
export const STRATEGY_REGISTRY = [...BASE_STRATEGY_REGISTRY, ...CONSENSUS_STRATEGIES];
export const STRATEGY_GROUPS = [...BASE_STRATEGY_GROUPS, CONSENSUS_STRATEGY_GROUP];
export const FEATURED_STRATEGY_IDS = [...BASE_FEATURED_STRATEGY_IDS, ...CONSENSUS_FEATURED_STRATEGY_IDS];

const byId = new Map(STRATEGY_REGISTRY.map((strategy) => [strategy.id, strategy]));

export function strategyById(id) {
  return byId.get(id) ?? null;
}

export function enabledStrategies() {
  return STRATEGY_REGISTRY.filter((strategy) => strategy.enabled !== false);
}

export function registryDuplicateIds() {
  const seen = new Set();
  const duplicates = [];
  for (const strategy of STRATEGY_REGISTRY) {
    if (seen.has(strategy.id)) duplicates.push(strategy.id);
    seen.add(strategy.id);
  }
  return duplicates;
}

// OOS definition identity. No prospective OOS snapshot exists before this
// change, so v2 becomes the clean experiment definition from the first live
// signal day. The base registry hash remains test-locked; the consensus layer
// has its own explicit version because it is intentionally kept outside the 94
// base definitions used by the simulator candidate panel.
export const STRATEGY_DEFINITION_VERSION = 2;
export const STRATEGY_REGISTRY_HASH = "ecd781bca1b696b0cb665ba2e43e497f2f916050";
export const STRATEGY_OOS_SCHEMA = `strategy-oos-1-def${STRATEGY_DEFINITION_VERSION}-${STRATEGY_REGISTRY_HASH.slice(0, 12)}-cons${CONSENSUS_DEFINITION_VERSION}`;
