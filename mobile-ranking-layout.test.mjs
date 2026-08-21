import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const leaderHtml = fs.readFileSync(new URL("./public/leader.html", import.meta.url), "utf8");
const scoutHtml = fs.readFileSync(new URL("./public/scout.html", import.meta.url), "utf8");
const compactCss = fs.readFileSync(new URL("./public/mobile-compact-ranking.css", import.meta.url), "utf8");
const tuneCss = fs.readFileSync(new URL("./public/mobile-compact-ranking-tune.css", import.meta.url), "utf8");
const leaderJs = fs.readFileSync(new URL("./public/leader.js", import.meta.url), "utf8");
const scoutJs = fs.readFileSync(new URL("./public/scout.js", import.meta.url), "utf8");

test("leader and scout mobile pages load the compact ranking styles", () => {
  for (const html of [leaderHtml, scoutHtml]) {
    assert.match(html, /mobile-compact-ranking\.css/);
    assert.match(html, /mobile-compact-ranking-tune\.css/);
  }
});

test("mobile CSS shows sortable tables and suppresses the old card lists", () => {
  assert.match(compactCss, /\.leader-wrap[\s\S]*display:\s*block\s*!important/);
  assert.match(compactCss, /\.scout-wrap[\s\S]*display:\s*block\s*!important/);
  assert.match(compactCss, /#leaderCards[\s\S]*#reboundCards[\s\S]*display:\s*none\s*!important/);
  assert.match(compactCss, /\.leader-table[\s\S]*min-width:\s*0\s*!important/);
  assert.match(compactCss, /\.scout-table[\s\S]*min-width:\s*0\s*!important/);
});

test("existing mobile-visible headers keep two-way sorting handlers", () => {
  assert.match(leaderJs, /\[data-leader-sort\][\s\S]*addEventListener\("click"/);
  assert.match(leaderJs, /state\.sortDirection = state\.sortDirection === "desc" \? "asc" : "desc"/);
  assert.match(scoutJs, /\[data-scout-sort\][\s\S]*addEventListener\("click"/);
  assert.match(scoutJs, /state\.sortDirection = state\.sortDirection === "desc" \? "asc" : "desc"/);
});

test("long mobile judgement labels are shortened without changing data", () => {
  assert.match(tuneCss, /content:\s*"반등"/);
  assert.match(tuneCss, /content:\s*"관찰"/);
  assert.match(tuneCss, /content:\s*"위험"/);
});
