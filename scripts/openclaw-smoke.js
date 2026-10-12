import path from "node:path";
import { JuneConversation } from "../src/adapter.js";
const entry = path.join(
  process.env.APPDATA,
  "npm/node_modules/openclaw/dist/index.js",
);
try {
  const result = await new JuneConversation({ openclawEntry: entry }).converse({
    text: "Synthetic connectivity test. Reply exactly JUNE_SMOKE_OK. Do not use tools or send any messages.",
    sessionId: "synthetic-memory-disabled-" + Date.now(),
    memoryEnabled: false,
  });
  console.log(
    JSON.stringify({
      ok: result.text.includes("JUNE_SMOKE_OK"),
      memoryEnabled: false,
      normalConversation: true,
    }),
  );
  if (!result.text.includes("JUNE_SMOKE_OK")) process.exitCode = 1;
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      memoryEnabled: false,
      error: e.code ?? "UNAVAILABLE",
      normalConversation: false,
    }),
  );
  process.exitCode = 1;
}
