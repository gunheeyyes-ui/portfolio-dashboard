// Filter Registry for Backtest Lab V3.
//
// A filter is data, not code: every condition is a plain object that names a
// field on an observation, an operator, and a value. Conditions compose with
// all / any / not, so combinations are built by configuration rather than by
// adding another hard-coded strategy function.
//
// NA handling is deliberate: a field the historical data cannot reproduce is
// null/undefined, and every comparison against it returns false rather than
// silently treating it as 0 or false. `isNA` / `notNA` are the only operators
// that inspect missingness directly.

export const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => numeric(a) !== null && numeric(a) > b,
  gte: (a, b) => numeric(a) !== null && numeric(a) >= b,
  lt: (a, b) => numeric(a) !== null && numeric(a) < b,
  lte: (a, b) => numeric(a) !== null && numeric(a) <= b,
  // Inclusive on both ends: [min, max].
  between: (a, b) => {
    const v = numeric(a);
    return v !== null && v >= b[0] && v <= b[1];
  },
  in: (a, b) => Array.isArray(b) && b.includes(a),
  notIn: (a, b) => Array.isArray(b) && a !== null && a !== undefined && !b.includes(a),
  true: (a) => a === true,
  false: (a) => a === false,
  isNA: (a) => a === null || a === undefined || a === "" || (typeof a === "number" && !Number.isFinite(a)),
  notNA: (a) => !(a === null || a === undefined || a === "" || (typeof a === "number" && !Number.isFinite(a)))
};

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when the row satisfies the condition tree. Unknown ops throw. */
export function evaluate(node, row) {
  if (!node) return true;
  if (Array.isArray(node)) return node.every((child) => evaluate(child, row));
  if (node.all) return node.all.every((child) => evaluate(child, row));
  if (node.any) return node.any.some((child) => evaluate(child, row));
  if (node.not) return !evaluate(node.not, row);
  const op = OPERATORS[node.op];
  if (!op) throw new Error(`Unknown filter operator: ${node.op}`);
  return Boolean(op(row[node.field], node.value));
}

/** Human-readable form, used in report tables and CSV keys. */
export function describe(node) {
  if (!node) return "ALL";
  if (Array.isArray(node)) return node.map(describe).join(" AND ");
  if (node.all) return node.all.map(describe).join(" AND ");
  if (node.any) return `(${node.any.map(describe).join(" OR ")})`;
  if (node.not) return `NOT(${describe(node.not)})`;
  const v = Array.isArray(node.value) ? `[${node.value.join(",")}]` : node.value;
  if (node.op === "true") return node.field;
  if (node.op === "false") return `!${node.field}`;
  return `${node.field} ${node.op} ${v}`;
}

/**
 * A named, self-describing filter. `axis` groups filters for the automatic
 * 2-factor crossing so unrelated axes (e.g. two Risk buckets) are not paired.
 */
export function defineFilter(name, axis, condition, options = {}) {
  return { name, axis, condition, describe: describe(condition), ...options };
}

/** Bucket helper: builds one filter per numeric range on the same axis. */
export function bucketFilters(prefix, axis, field, ranges) {
  return ranges.map(([min, max, label]) =>
    defineFilter(`${prefix}_${label ?? `${min}~${max}`}`, axis, { field, op: "between", value: [min, max] }));
}

/** Threshold helper: builds one filter per cut point (gte, or lte when descending). */
export function thresholdFilters(prefix, axis, field, cuts, direction = "gte") {
  return cuts.map((cut) =>
    defineFilter(`${prefix}_${direction}${cut}`, axis, { field, op: direction, value: cut }, { sweep: { field, cut, direction } }));
}

export function andFilters(name, axis, filters) {
  return defineFilter(name, axis, { all: filters.map((f) => f.condition) });
}
