import assert from "node:assert/strict";
import test from "node:test";

import {
  batchKeyForRequest,
  inputHashForRequest,
  requestLunaReviews,
  sanitizeReviewRequest
} from "./ai-review-service.js";

test("sanitizes and caps candidate input without changing dashboard scores", () => {
  const request = sanitizeReviewRequest({
    signalDate: "2026-09-07",
    dataMode: "EOD_FULL",
    candidates: Array.from({ length: 7 }, (_, index) => ({
      code: String(index + 1).padStart(6, "0"),
      name: `종목${index + 1}`,
      candidateLabel: index === 0 ? "core" : "strong",
      leader: { score: 91 - index, grade: "A", rank: index + 1 },
      risk: 20 + index,
      stabilize: 90 - index
    }))
  }, 5);
  assert.equal(request.candidates.length, 5);
  assert.equal(request.candidates[0].leader.score, 91);
  assert.equal(request.candidates[0].risk, 20);
  assert.equal(request.candidates[0].stabilize, 90);
});

test("batch key freezes one review batch per signal date and visible code order", () => {
  const request = sanitizeReviewRequest({
    signalDate: "2026-09-07",
    candidates: [
      { code: "000001", name: "A" },
      { code: "000002", name: "B" }
    ]
  });
  assert.equal(batchKeyForRequest(request), "2026-09-07:000001,000002");
  assert.equal(inputHashForRequest(request, "gpt-5.6-luna").length, 64);
});

test("Luna request uses Responses API structured output and validates all codes", async () => {
  let captured;
  const fakeFetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "resp_test",
          model: "gpt-5.6-luna",
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({ reviews: [
                {
                  code: "000001",
                  verdict: "POSITIVE",
                  confidence: 81,
                  bull_case: "주도력과 안정화가 양호",
                  bear_case: "단기 과열 가능성",
                  key_risks: ["수급 반전"],
                  invalidation: "Risk 50 이상",
                  summary: "긍정이나 추격 금지"
                },
                {
                  code: "000002",
                  verdict: "NEUTRAL",
                  confidence: 66,
                  bull_case: "RS 양호",
                  bear_case: "Risk가 상대적으로 높음",
                  key_risks: [],
                  invalidation: "Leader C 하락",
                  summary: "관찰 우선"
                }
              ] })
            }]
          }]
        };
      }
    };
  };
  const request = sanitizeReviewRequest({
    signalDate: "2026-09-07",
    candidates: [
      { code: "000001", name: "A" },
      { code: "000002", name: "B" }
    ]
  });
  const result = await requestLunaReviews({ request, apiKey: "test", fetchImpl: fakeFetch });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.body.model, "gpt-5.6-luna");
  assert.equal(captured.body.reasoning.effort, "low");
  assert.equal(captured.body.text.format.type, "json_schema");
  assert.equal(captured.body.store, false);
  assert.deepEqual(result.reviews.map((review) => review.code), ["000001", "000002"]);
});
