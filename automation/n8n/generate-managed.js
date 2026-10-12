import fs from "node:fs/promises";
import path from "node:path";
import { buildWorkflows } from "./generate.js";
export function managedWorkflows() {
  const workflows = buildWorkflows();
  for (const w of workflows) {
    if (["june-consolidation", "june-reminders"].includes(w.id)) {
      const n = w.nodes.find((n) => n.name === "Job configuration");
      n.parameters.jsCode = n.parameters.jsCode.replace(
        '"dryRun":true',
        '"dryRun":false',
      );
    }
  }
  for (const d of [
    { id: "collect", name: "06 June collect mailboxes", cron: "*/5 * * * *" },
    {
      id: "process",
      name: "07 June local inbox processing",
      cron: "* * * * *",
    },
    {
      id: "research",
      name: "08 June research and opportunity briefs",
      cron: "*/15 * * * *",
    },
  ]) {
    const w = structuredClone(workflows.find((w) => w.id === "june-health"));
    w.id = "june-" + d.id;
    w.name = d.name;
    w.nodes.find(
      (n) => n.name === "Local schedule",
    ).parameters.rule.interval[0].expression = d.cron;
    w.nodes.find((n) => n.name === "Memory engine").parameters.url =
      "http://127.0.0.1:3211/v1/jobs/" + d.id;
    workflows.push(w);
  }
  return workflows;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(import.meta.dirname, "generate-managed.js")
) {
  const dir = path.join(import.meta.dirname, "managed-workflows");
  await fs.mkdir(dir, { recursive: true });
  for (const w of managedWorkflows())
    await fs.writeFile(
      path.join(dir, w.id + ".json"),
      JSON.stringify(w, null, 2) + "\n",
    );
  console.log("Generated eight configured local workflows.");
}
