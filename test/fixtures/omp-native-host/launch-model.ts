import assert from "node:assert/strict";
import { join } from "node:path";
import { requiredSourceRequest } from "./required-source.ts";

const [boundary, availability] = process.argv.slice(2);
assert(boundary === "session" || boundary === "provider");
assert(["available", "unavailable", "thinking", "thinking-mismatch", "advisor"].includes(availability ?? ""));
const thinking = availability === "thinking" ? "high" : availability === "thinking-mismatch" ? "low" : undefined;
const advisor = availability === "advisor";
const available = availability === "available" || availability === "thinking" || advisor;
const result = await requiredSourceRequest(
  join(import.meta.dir, "../../../extension/index.ts"),
  process.cwd(),
  "lane",
  boundary,
  availability === "unavailable" ? "openai/absent" : `openai/required-source-local${thinking ? ":high" : ""}`,
  thinking,
  advisor,
);
assert.deepEqual(result.errors.filter((error) => error.event === "session_start"), []);
// OMP reports the advisor's own request, on its own model, through the main agent's before_provider_request.
if (advisor) {
  assert.equal(result.models[0], "required-source-local");
  assert.deepEqual(result.errors, []);
} else assert.equal(result.requests, available ? 1 : 0);
if (!available) assert(result.errors.some((error) => error.error.includes("STARTUP_MODEL_HOLD")));
