import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildWorkflows,
  validateCode,
  outcomeCode,
} from "../automation/n8n/generate.js";
const run = (code, json) =>
  JSON.parse(
    JSON.stringify(
      vm.runInNewContext("(function(){" + code + "})()", { $json: json }),
    ),
  );
test("five inactive workflows use local authenticated API, timezone and nonpersistent execution data", () => {
  const workflows = buildWorkflows();
  assert.equal(workflows.length, 5);
  for (const w of workflows) {
    assert.equal(w.active, false);
    assert.equal(w.settings.saveDataErrorExecution, "none");
    assert.equal(w.settings.timezone, "Asia/Calcutta");
    const http = w.nodes.find((n) => n.type === "n8n-nodes-base.httpRequest");
    assert.ok(http.parameters.url.startsWith("http://127.0.0.1:3210/"));
    assert.equal(http.credentials.httpHeaderAuth.id, "june-memory-worker");
    for (const [name, c] of Object.entries(w.connections)) {
      assert.ok(w.nodes.some((n) => n.name === name));
      for (const outputs of c.main)
        for (const item of outputs ?? [])
          assert.ok(w.nodes.some((n) => n.name === item.node));
    }
  }
  assert.equal(
    workflows[0].nodes.find((n) => n.type === "n8n-nodes-base.webhook")
      .parameters.authentication,
    "headerAuth",
  );
});
test("exported candidate validation rejects malformed and excessive requests", () => {
  assert.equal(
    run(validateCode, { body: { sessionId: "s", messages: [] } })[0].json.valid,
    false,
  );
  assert.equal(
    run(validateCode, {
      body: {
        sessionId: "s",
        messages: [
          { role: "user", content: "x", timestamp: "2026-10-12T09:00:00Z" },
        ],
      },
    })[0].json.valid,
    true,
  );
  assert.equal(
    run(validateCode, {
      body: {
        sessionId: "s",
        messages: [
          {
            role: "user",
            content: "x".repeat(49000),
            timestamp: "2026-10-12T09:00:00Z",
          },
        ],
      },
    })[0].json.valid,
    false,
  );
});
test("exported outcome paths discard conversation text, credentials and raw errors", () => {
  const outcome = run(outcomeCode, {
    error: {
      message: "token=private-secret",
      request: { messages: ["secret conversation"] },
    },
  })[0].json;
  assert.equal(outcome.ok, false);
  assert.ok(!JSON.stringify(outcome).includes("private-secret"));
  assert.equal(outcome.httpStatus, 503);
  const good = run(outcomeCode, {
    statusCode: 200,
    body: { ok: true, observations: [{ claim: "private memory" }] },
  })[0].json;
  assert.equal(good.candidates, 1);
  assert.ok(!JSON.stringify(good).includes("private memory"));
});
