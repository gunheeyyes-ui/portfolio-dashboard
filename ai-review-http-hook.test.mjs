import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// Importing the hook patches http.createServer. The fallback listener must still
// receive every non-AI route unchanged.
await import("./ai-review-http-hook.mjs");

test("HTTP hook delegates non-AI routes to the original dashboard listener", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`core:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(await response.text(), "core:/api/health");
  await new Promise((resolve) => server.close(resolve));
});

test("status route is fail-soft when OPENAI_API_KEY is absent", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const server = http.createServer((req, res) => {
    res.writeHead(404); res.end("core");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/ai-review/status`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.enabled, false);
  await new Promise((resolve) => server.close(resolve));
  if (previous) process.env.OPENAI_API_KEY = previous;
});
