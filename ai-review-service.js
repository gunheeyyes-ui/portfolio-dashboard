import crypto from "node:crypto";

export const AI_REVIEW_SCHEMA_VERSION = "ai-review-v1";
export const AI_VERDICTS = [
  "STRONG_POSITIVE",
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "REJECT"
];

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviews: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string", pattern: "^[0-9]{6}$" },
          verdict: { type: "string", enum: AI_VERDICTS },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          bull_case: { type: "string", maxLength: 260 },
          bear_case: { type: "string", maxLength: 260 },
          key_risks: {
            type: "array",
            minItems: 0,
            maxItems: 4,
            items: { type: "string", maxLength: 120 }
          },
          invalidation: { type: "string", maxLength: 220 },
          summary: { type: "string", maxLength: 220 }
        },
        required: [
          "code",
          "verdict",
          "confidence",
          "bull_case",
          "bear_case",
          "key_risks",
          "invalidation",
          "summary"
        ]
      }
    }
  },
  required: ["reviews"]
};

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function cleanText(value, max = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanBool(value) {
  return value === true;
}

export function sanitizeCandidate(candidate = {}) {
  const code = String(candidate.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error(`INVALID_CANDIDATE_CODE:${code || "EMPTY"}`);
  return {
    code,
    name: cleanText(candidate.name, 80),
    market: ["KOSPI", "KOSDAQ"].includes(candidate.market) ? candidate.market : null,
    candidateLabel: ["core", "strong"].includes(candidate.candidateLabel) ? candidate.candidateLabel : "unknown",
    candidateDisplay: cleanText(candidate.candidateDisplay, 40),
    price: numberOrNull(candidate.price),
    changeRate: numberOrNull(candidate.changeRate),
    changeRate3d: numberOrNull(candidate.changeRate3d),
    drawdownFromHighPct: numberOrNull(candidate.drawdownFromHighPct),
    leader: {
      grade: cleanText(candidate.leader?.grade, 8) || null,
      score: numberOrNull(candidate.leader?.score),
      rank: numberOrNull(candidate.leader?.rank)
    },
    timing: {
      score: numberOrNull(candidate.timing?.score),
      label: cleanText(candidate.timing?.label, 60) || null
    },
    rs20: numberOrNull(candidate.rs20),
    strategyConsensus: cleanText(candidate.strategyConsensus, 80),
    rebound: cleanText(candidate.rebound, 120),
    risk: numberOrNull(candidate.risk),
    stabilize: numberOrNull(candidate.stabilize),
    supply: {
      liquidityScore: numberOrNull(candidate.supply?.liquidityScore),
      foreignStreak: numberOrNull(candidate.supply?.foreignStreak),
      institutionStreak: numberOrNull(candidate.supply?.institutionStreak),
      totalNetAmount: numberOrNull(candidate.supply?.totalNetAmount),
      smartMoneyTradingSharePct: numberOrNull(candidate.supply?.smartMoneyTradingSharePct)
    },
    confirmations: {
      cafe: cleanBool(candidate.confirmations?.cafe),
      mtt: cleanBool(candidate.confirmations?.mtt),
      leaderRebound: cleanBool(candidate.confirmations?.leaderRebound)
    },
    judgement: cleanText(candidate.judgement, 240),
    reasons: Array.isArray(candidate.reasons)
      ? candidate.reasons.slice(0, 6).map((item) => cleanText(item, 140)).filter(Boolean)
      : []
  };
}

export function sanitizeReviewRequest(payload = {}, maxCandidates = 5) {
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates.slice(0, Math.max(1, Math.min(5, maxCandidates))).map(sanitizeCandidate)
    : [];
  if (!candidates.length) throw new Error("NO_AI_REVIEW_CANDIDATES");
  const duplicateCodes = candidates.map((item) => item.code).filter((code, index, all) => all.indexOf(code) !== index);
  if (duplicateCodes.length) throw new Error(`DUPLICATE_AI_REVIEW_CODE:${duplicateCodes[0]}`);
  const signalDate = cleanText(payload.signalDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) throw new Error("INVALID_AI_REVIEW_SIGNAL_DATE");
  return {
    schemaVersion: AI_REVIEW_SCHEMA_VERSION,
    signalDate,
    dataMode: cleanText(payload.dataMode, 24) || null,
    marketDataAsOf: cleanText(payload.marketDataAsOf, 10) || signalDate,
    candidates
  };
}

export function batchKeyForRequest(request) {
  const codes = request.candidates.map((item) => item.code).join(",");
  return `${request.signalDate}:${codes}`;
}

export function inputHashForRequest(request, model) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ schemaVersion: AI_REVIEW_SCHEMA_VERSION, model, request }))
    .digest("hex");
}

export function buildAiReviewPrompt(request) {
  return [
    "You are the independent red-team investment review layer for a Korean equity dashboard.",
    "The dashboard's existing ranking, entry verdict, OOS rules, and scores are authoritative inputs. Never recalculate, replace, or override them.",
    "Use ONLY the supplied dashboard snapshot. Do not infer or claim news, filings, earnings, valuation, macro events, or facts that are not present in the input.",
    "Your role is to stress-test each candidate using Bull / Bear / Risk reasoning and identify whether the supplied evidence itself contains reasons to downgrade the candidate.",
    "A REJECT verdict requires a material contradiction or risk visible in the supplied data. Missing external information alone is not grounds for REJECT.",
    "Confidence means confidence in your review of the supplied data, not probability of profit.",
    "Keep each field concise and concrete. Korean output is preferred for prose fields.",
    `As-of signal date: ${request.signalDate}`,
    "Candidates JSON follows:",
    JSON.stringify(request.candidates)
  ].join("\n");
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  for (const item of data?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function validateReviews(result, request) {
  if (!result || !Array.isArray(result.reviews)) throw new Error("AI_REVIEW_OUTPUT_MISSING");
  const expected = new Set(request.candidates.map((item) => item.code));
  const seen = new Set();
  for (const review of result.reviews) {
    if (!expected.has(review.code)) throw new Error(`AI_REVIEW_UNKNOWN_CODE:${review.code}`);
    if (seen.has(review.code)) throw new Error(`AI_REVIEW_DUPLICATE_CODE:${review.code}`);
    if (!AI_VERDICTS.includes(review.verdict)) throw new Error(`AI_REVIEW_BAD_VERDICT:${review.verdict}`);
    if (!Number.isInteger(review.confidence) || review.confidence < 0 || review.confidence > 100) {
      throw new Error(`AI_REVIEW_BAD_CONFIDENCE:${review.code}`);
    }
    seen.add(review.code);
  }
  if (seen.size !== expected.size) throw new Error("AI_REVIEW_INCOMPLETE_CODES");
  return result.reviews;
}

export async function requestLunaReviews({
  request,
  apiKey,
  model = "gpt-5.6-luna",
  reasoningEffort = "low",
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  maxOutputTokens = 3200
}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");
  if (typeof fetchImpl !== "function") throw new Error("FETCH_UNAVAILABLE");

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      instructions: "Return only the structured review object that matches the supplied schema.",
      input: buildAiReviewPrompt(request),
      text: {
        format: {
          type: "json_schema",
          name: "korean_equity_ai_review",
          strict: true,
          schema: REVIEW_SCHEMA
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `OpenAI HTTP ${response.status}`;
    throw new Error(`OPENAI_API_ERROR:${message}`);
  }
  const outputText = extractOutputText(data);
  if (!outputText) throw new Error("OPENAI_EMPTY_AI_REVIEW");

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("OPENAI_AI_REVIEW_JSON_PARSE_FAILED");
  }
  const reviews = validateReviews(parsed, request);
  return {
    model: data.model || model,
    responseId: data.id || null,
    reviews,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null
    }
  };
}
