import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export function readGeminiKeys(settings) {
  let lines = [];
  try {
    lines = fs
      .readFileSync(path.join(settings, "gemini-api-keys.txt"), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const keys = [
    ...new Set(lines.filter((s) => /^[A-Za-z0-9_.-]{20,256}$/.test(s))),
  ];
  return { keys, skipped: lines.length - keys.length };
}
export function refreshGatewayKeys(settings, env = process.env) {
  const { keys, skipped } = readGeminiKeys(settings);
  if (keys.length) {
    env.GEMINI_API_KEYS = keys.join(",");
    env.GEMINI_API_KEY = keys[0];
  } else {
    delete env.GEMINI_API_KEYS;
    delete env.GEMINI_API_KEY;
  }
  return {
    configured: keys.length,
    skipped,
    loadedAt: new Date().toISOString(),
  };
}

// For June's scheduled public research, read the pool on every operation.
// Only generation is retried; no external tools/actions are ever replayed here.
export class GeminiPool {
  constructor({
    settings,
    pendingRoot,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    model = "gemini-3.7-flash",
  }) {
    Object.assign(this, { settings, pendingRoot, fetchImpl, sleep, model });
    this.cooldowns = new Map();
    this.cursor = 0;
    this.last = null;
  }
  status() {
    const { keys, skipped } = readGeminiKeys(this.settings);
    return {
      configured: keys.length,
      skipped,
      model: this.model,
      last: this.last,
      slots: keys.map((k, i) => ({
        slot: i + 1,
        coolingDown: (this.cooldowns.get(k) ?? 0) > Date.now(),
      })),
    };
  }
  completePending(requestId) {
    const file = path.join(
      this.pendingRoot,
      createHash("sha256").update(requestId).digest("hex") + ".json",
    );
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async generate(payload, { model = this.model, requestId } = {}) {
    const { keys } = readGeminiKeys(this.settings);
    if (!keys.length) throw Error("GEMINI_KEYS_REQUIRED");
    fs.mkdirSync(this.pendingRoot, { recursive: true });
    const id = requestId
        ? createHash("sha256").update(requestId).digest("hex")
        : randomUUID(),
      file = path.join(this.pendingRoot, id + ".json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        id,
        model,
        payload,
        createdAt: new Date().toISOString(),
        status: "pending",
      }),
      { mode: 0o600 },
    );
    let reason = "GEMINI_UNAVAILABLE";
    for (let n = 0; n < keys.length; n++) {
      const slot = (this.cursor + n) % keys.length,
        key = keys[slot];
      if ((this.cooldowns.get(key) ?? 0) > Date.now()) {
        reason = "GEMINI_POOL_COOLDOWN";
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
          response = await this.fetchImpl(
            "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(model) +
              ":generateContent",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-goog-api-key": key,
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(60000),
              redirect: "error",
            },
          );
        } catch {
          reason = "GEMINI_NETWORK_UNAVAILABLE";
          if (!attempt) {
            await this.sleep(500);
            continue;
          }
          break;
        }
        const data = await response.json();
        this.last = {
          at: new Date().toISOString(),
          slot: slot + 1,
          httpStatus: response.status,
          model,
        };
        if (response.ok) {
          if (!data.candidates?.[0]?.content?.parts?.length) {
            reason = "GEMINI_EMPTY_RESPONSE";
            break;
          }
          this.cursor = (slot + 1) % keys.length;
          fs.unlinkSync(file);
          return data;
        }
        if (response.status === 429) {
          const delay = data.error?.details?.find(
            (x) => x.retryDelay,
          )?.retryDelay;
          const seconds =
            Number.parseFloat(delay) ||
            Number(response.headers?.get("retry-after")) ||
            60;
          this.cooldowns.set(
            key,
            Date.now() + Math.min(86400000, Math.max(1000, seconds * 1000)),
          );
          reason = "GEMINI_QUOTA_EXHAUSTED";
          break;
        }
        if ([401, 403].includes(response.status)) {
          this.cooldowns.set(key, Date.now() + 300000);
          reason = "GEMINI_KEY_REJECTED";
          break;
        }
        if (response.status >= 500) {
          reason = "GEMINI_TEMPORARILY_BUSY";
          if (!attempt) {
            await this.sleep(1000);
            continue;
          }
          break;
        }
        reason =
          response.status === 400
            ? "GEMINI_REQUEST_REJECTED"
            : "GEMINI_MODEL_UNAVAILABLE";
        fs.writeFileSync(
          file,
          JSON.stringify({ id, model, payload, status: "failed", reason }),
          { mode: 0o600 },
        );
        throw Error(reason);
      }
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        id,
        model,
        payload,
        status: "waiting",
        reason,
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    throw Error(reason);
  }
}
