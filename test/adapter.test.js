import assert from "node:assert/strict";
import test from "node:test";
import { MemoryClient, JuneConversation } from "../src/adapter.js";
import plugin from "../integrations/openclaw/index.js";
test("conversation continues when custom memory is disabled or unavailable", async () => {
  let calls = 0,
    lookups = 0;
  const run = async ({ args }) => {
    calls++;
    assert.ok(args.includes("--agent"));
    assert.ok(!args.includes("--deliver"));
    return { result: { payloads: [{ text: "June is here." }] } };
  };
  const memory = new MemoryClient({
    token: "synthetic",
    fetchImpl: async () => {
      lookups++;
      throw Error("offline");
    },
  });
  const june = new JuneConversation({ openclawEntry: "mock", memory, run });
  assert.equal(
    (
      await june.converse({
        text: "Hello June",
        sessionId: "synthetic",
        memoryEnabled: false,
      })
    ).text,
    "June is here.",
  );
  assert.equal(lookups, 0);
  assert.equal(
    (await june.converse({ text: "Hello June", sessionId: "synthetic" })).text,
    "June is here.",
  );
  assert.equal(lookups, 1);
  assert.equal(calls, 2);
});
test("OpenClaw outage is surfaced rather than fabricating a response", async () => {
  const june = new JuneConversation({
    openclawEntry: "mock",
    run: async () => {
      throw Error("Gateway unavailable");
    },
  });
  await assert.rejects(
    () => june.converse({ text: "Hello", sessionId: "synthetic" }),
    /Gateway unavailable/,
  );
});
test("tool adapter is optional, read-only, bounded, and fails softly without credentials", async () => {
  let definition, options;
  plugin.register({
    registerCommand() {},
    on() {},
    registerTool: (d, o) => {
      definition = d;
      options = o;
    },
    pluginConfig: {},
  });
  assert.equal(definition.name, "june_memory_search");
  assert.equal(options.optional, true);
  const result = await definition.execute("test", { query: "written plans" });
  assert.equal(result.details.available, false);
  assert.deepEqual(result.details.results, []);
});
