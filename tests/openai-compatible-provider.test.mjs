import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("OpenAI-compatible provider is wired through shared router and provider executor", async () => {
  const shared = await readFile(path.join(repoRoot, "source/shared/inference-router.ts"), "utf8");
  const session = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  assert.match(shared, /"openai-compatible"/);
  assert.match(session, /SAND_OPENAI_COMPATIBLE_BASE_URL/);
  assert.match(session, /SAND_OPENAI_COMPATIBLE_MODEL/);
  assert.match(session, /OPENAI_COMPATIBLE_API_KEY/);
  assert.match(session, /provider === "openai-compatible"/);
  assert.match(session, /openAICompatibleExecutor/);
  assert.match(session, /compatibility: "compatible"/);
});

test("OpenAI-compatible remote endpoints require HTTPS while localhost remains available", async () => {
  const session = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  assert.match(session, /parsed\.protocol !== "https:"/);
  assert.match(session, /parsed\.hostname !== "localhost"/);
  assert.match(session, /parsed\.hostname !== "127\.0\.0\.1"/);
});
