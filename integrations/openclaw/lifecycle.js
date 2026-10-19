import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { localCommand } from "../../src/hub/settings.js";
import { redactSensitiveText } from "../../src/util.js";
import { refreshGatewayKeys } from "../../src/hub/gemini-pool.js";

const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

export function registerJuneLifecycle(
  api,
  env = process.env,
  fetchImpl = fetch,
) {
  const root =
    env.JUNE_PENDING_ROOT ?? "D:/June/JuneMemory/.local/gemini-pending";
  const settings = env.JUNE_SETTINGS_ROOT ?? "D:/June/Settings";
  const reloadKeys = () => {
    try {
      return refreshGatewayKeys(settings, env);
    } catch {
      api.logger?.warn(
        "June key-pool file could not be read; existing gateway keys retained.",
      );
    }
  };
  reloadKeys();
  const pending = (id) => path.join(root, hash(id) + ".json");
  const inFlight = new Map();
  api.registerCommand({
    name: "priority",
    description:
      "Add a WhatsApp priority contact locally. Usage: /priority add Name",
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: ["operator.write"],
    handler: (ctx) => {
      try {
        const result = localCommand(settings, "priority " + (ctx.args ?? ""));
        return {
          text:
            "Priority saved: " + result.value + ". No model request was used.",
        };
      } catch {
        return { text: "Use /priority add Name or phone number." };
      }
    },
  });
  api.registerCommand({
    name: "juneignore",
    description: "Ignore a WhatsApp person or group locally.",
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: ["operator.write"],
    handler: (ctx) => {
      try {
        const result = localCommand(settings, "ignore " + (ctx.args ?? ""));
        return {
          text: "Ignored: " + result.value + ". No model request was used.",
        };
      } catch {
        return { text: "Use /juneignore Group name or phone number." };
      }
    },
  });
  api.on("llm_input", (event, ctx) => {
    if (event.provider !== "google" || !event.runId) return;
    reloadKeys();
    const previous = inFlight.get(event.runId);
    const record = {
      runId: event.runId,
      sessionId: event.sessionId,
      agentId: ctx?.agentId,
      provider: event.provider,
      model: event.model,
      createdAt: new Date().toISOString(),
      prompt: redactSensitiveText(String(event.prompt ?? "")).slice(0, 48000),
      status: "pending",
      recovery:
        "OpenClaw owns bounded in-turn key rotation. Check the native transcript before resuming.",
    };
    // Register before yielding: native hook dispatch does not await these handlers.
    const item = { record, delivered: previous?.delivered ?? false };
    inFlight.set(event.runId, item);
    item.write = (async () => {
      await previous?.write;
      await fs.mkdir(root, { recursive: true });
      const file = pending(event.runId);
      await fs.writeFile(file + ".tmp", JSON.stringify(record), {
        mode: 0o600,
      });
      await fs.rename(file + ".tmp", file);
    })().catch(() =>
      api.logger?.warn(
        "June could not persist the temporary request; native transcript remains available.",
      ),
    );
    return item.write;
  });
  async function complete(runId, ctx, outputEvent) {
    let item = inFlight.get(runId);
    if (!item) {
      const record = await fs
        .readFile(pending(runId), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (!record) return;
      item = { record, delivered: false };
      inFlight.set(runId, item);
    }
    await item.write;
    const { record } = item;
    if (
      (ctx?.agentId ?? record.agentId) === "main" &&
      record.prompt.trim() &&
      !item.delivered &&
      env.JUNE_WORKER_TOKEN
    ) {
      item.delivered = true;
      try {
        const response = await fetchImpl("http://127.0.0.1:3211/v1/intake", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + env.JUNE_WORKER_TOKEN,
          },
          body: JSON.stringify({
            source: "conversation",
            account: "openclaw-main",
            externalId: runId,
            receivedAt: record.createdAt,
            sender: "local-owner",
            senderName: "You",
            text: record.prompt.slice(0, 15000),
          }),
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        });
        if (!response.ok) throw Error("INTAKE_UNAVAILABLE");
        await response.body?.cancel();
      } catch {
        // Do not keep a Gemini retry snapshot for an already answered request.
        api.logger?.warn(
          "June background intake unavailable; native transcript is preserved.",
        );
      }
    }
    // Only clear the matching attempt: a subsequent retry may reuse the run id.
    if (inFlight.get(runId) === item) {
      await fs.unlink(pending(runId)).catch((error) => {
        if (error.code !== "ENOENT")
          api.logger?.warn("June temporary request cleanup failed.");
      });
      inFlight.delete(runId);
    }
  }
  api.on("llm_output", async (event, ctx) => {
    if (event.provider !== "google" || !event.runId) return;
    const reason = event.lastAssistant?.stopReason;
    if (
      reason === "error" ||
      reason === "aborted" ||
      event.lastAssistant?.errorMessage
    )
      return;
    // Intermediate tool calls can be followed by a rate-limited completion.
    // Preserve the snapshot until a final answer or successful agent_end.
    if (
      reason === "toolUse" ||
      !event.assistantTexts?.some((text) => text?.trim())
    )
      return;
    await complete(event.runId, ctx, event);
  });
  api.on("agent_end", async (event, ctx) => {
    const id = event.runId ?? ctx?.runId;
    if (!id) return;
    if (event.success) await complete(id, ctx);
    else inFlight.delete(id); // Leave the persisted request available for recovery.
  });
}
