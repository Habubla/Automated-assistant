import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerJuneLifecycle } from "../integrations/openclaw/lifecycle.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-hooks-")),
    hooks = {},
    commands = [],
    calls = [];
  registerJuneLifecycle(
    {
      on: (name, handler) => (hooks[name] = handler),
      registerCommand: (command) => commands.push(command),
      logger: { warn() {} },
    },
    {
      JUNE_PENDING_ROOT: path.join(root, "pending"),
      JUNE_SETTINGS_ROOT: root,
      JUNE_WORKER_TOKEN: "synthetic-worker",
    },
    async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    },
  );
  return {
    root,
    hooks,
    commands,
    calls,
    async files() {
      return fs.readdir(path.join(root, "pending"));
    },
    async close() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
const input = {
  runId: "fixture-1",
  sessionId: "fixture-session",
  provider: "google",
  model: "fixture",
  prompt: "I prefer written plans.",
};
test("native output without prompt recovers input, queues once and removes successful snapshot", async () => {
  const f = await fixture();
  try {
    const writing = f.hooks.llm_input(input, { agentId: "main" });
    await Promise.all([
      writing,
      f.hooks.llm_output(
        {
          ...input,
          prompt: undefined,
          assistantTexts: ["Understood."],
          lastAssistant: { stopReason: "stop" },
        },
        { agentId: "main" },
      ),
    ]);
    await f.hooks.agent_end(
      { runId: input.runId, success: true },
      { agentId: "main" },
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].text, input.prompt);
    assert.equal((await f.files()).length, 0);
  } finally {
    await f.close();
  }
});
test("quota errors and tool steps preserve pending snapshots; failed end never cleans them", async () => {
  const f = await fixture();
  try {
    await f.hooks.llm_input(input, { agentId: "main" });
    await f.hooks.llm_output(
      {
        ...input,
        assistantTexts: ["Searching"],
        lastAssistant: { stopReason: "toolUse" },
      },
      { agentId: "main" },
    );
    await f.hooks.llm_output(
      {
        ...input,
        assistantTexts: ["Quota exceeded"],
        lastAssistant: { stopReason: "error", errorMessage: "429" },
      },
      { agentId: "main" },
    );
    await f.hooks.agent_end(
      { runId: input.runId, success: false },
      { agentId: "main" },
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.files()).length, 1);
  } finally {
    await f.close();
  }
});
test("research success cleans its snapshot without ingesting the research prompt as user memory", async () => {
  const f = await fixture();
  try {
    await f.hooks.llm_input(input, { agentId: "june-research" });
    await f.hooks.agent_end(
      { success: true },
      { runId: input.runId, agentId: "june-research" },
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.files()).length, 0);
  } finally {
    await f.close();
  }
});
test("priority slash command requires owner authorization and writes locally without fetch", async () => {
  const f = await fixture();
  try {
    const command = f.commands.find((c) => c.name === "priority");
    assert.equal(command.requireAuth, true);
    assert.deepEqual(command.requiredScopes, ["operator.write"]);
    assert.match(
      command.handler({ args: "add Professor Rao" }).text,
      /No model request/,
    );
    assert.match(
      await fs.readFile(path.join(f.root, "whatsapp-priority.txt"), "utf8"),
      /Professor Rao/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
