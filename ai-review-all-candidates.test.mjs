import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AI_REVIEW_CHUNK_SIZE,
  AI_REVIEW_MAX_TOTAL_CANDIDATES,
  requestLunaReviews,
  sanitizeReviewRequest
} from "./ai-review-service.js";

function candidate(index) {
  return {
    code: String(index + 1).padStart(6, "0"),
    name: `종목${index + 1}`,
    market: index % 2 === 0 ? "KOSPI" : "KOSDAQ",
    candidateLabel: "core",
    leader: { grade: "A", score: 95 - index, rank: index + 1 },
    risk: 20 + index,
    stabilize: 90 - index
  };
}

function review(code) {
  return {
    code,
    verdict: "POSITIVE",
    confidence: 80,
    bull_case: "주어진 정량 근거가 양호",
    bear_case: "단기 변동성 확인 필요",
    key_risks: ["수급 반전"],
    invalidation: "주요 정량 근거 훼손",
    summary: "긍정 검토"
  };
}

test("AI review accepts all 16 visible home candidates", () => {
  const request = sanitizeReviewRequest({
    signalDate: "2026-09-07",
    dataMode: "EOD_FULL",
    candidates: Array.from({ length: 16 }, (_, index) => candidate(index))
  }, AI_REVIEW_MAX_TOTAL_CANDIDATES);

  assert.equal(AI_REVIEW_MAX_TOTAL_CANDIDATES, 16);
  assert.equal(AI_REVIEW_CHUNK_SIZE, 5);
  assert.equal(request.candidates.length, 16);
  assert.equal(request.candidates.at(-1).code, "000016");
});

test("16 candidates are reviewed as 5+5+5+1 Luna calls and recombined in original order", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const suppliedCandidates = JSON.parse(body.input.split("\n").at(-1));
    calls.push({ url, body, codes: suppliedCandidates.map((item) => item.code) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: `resp_${calls.length}`,
          model: "gpt-5.6-luna",
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({ reviews: suppliedCandidates.map((item) => review(item.code)) })
            }]
          }]
        };
      }
    };
  };

  const request = sanitizeReviewRequest({
    signalDate: "2026-09-07",
    dataMode: "EOD_FULL",
    candidates: Array.from({ length: 16 }, (_, index) => candidate(index))
  }, 16);

  const result = await requestLunaReviews({
    request,
    apiKey: "test",
    fetchImpl: fakeFetch,
    batchSize: 5
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.codes.length), [5, 5, 5, 1]);
  assert.ok(calls.every((call) => call.url === "https://api.openai.com/v1/responses"));
  assert.ok(calls.every((call) => call.body.text.format.schema.properties.reviews.maxItems === 5));
  assert.equal(result.subBatches, 4);
  assert.deepEqual(result.reviews.map((item) => item.code), request.candidates.map((item) => item.code));
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 200, totalTokens: 600 });
});

test("server advertises 16 total candidates while preserving five-candidate Luna chunks", () => {
  const hook = readFileSync(new URL("./ai-review-http-hook.mjs", import.meta.url), "utf8");
  const frontend = readFileSync(new URL("./public/home-ai-review.js", import.meta.url), "utf8");

  assert.match(hook, /AI_REVIEW_MAX_TOTAL_CANDIDATES", 16, 1, 16/);
  assert.match(hook, /AI_REVIEW_MAX_CANDIDATES", 5, 1, 5/);
  assert.match(hook, /batchSize: cfg\.batchSize/);
  assert.match(frontend, /rows\.slice\(0, status\.maxCandidates \?\? 5\)/);
  assert.match(frontend, /state\.status\?\.maxCandidates \?\? 5/);
});
