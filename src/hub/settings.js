import fs from "node:fs";
import path from "node:path";
import { text } from "./store.js";
export function lines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
export function loadRules(root) {
  return {
    priority: lines(path.join(root, "whatsapp-priority.txt")),
    ignore: lines(path.join(root, "whatsapp-ignore.txt")),
  };
}
export function addRule(root, kind, value) {
  if (!["priority", "ignore"].includes(kind)) throw Error("Invalid list");
  value = text(value, 200);
  if (!value || /[\r\n]/.test(value))
    throw Error("One name or identifier required");
  const file = path.join(root, "whatsapp-" + kind + ".txt");
  const existing = lines(file);
  if (
    !existing.some((x) => x.toLocaleLowerCase() === value.toLocaleLowerCase())
  )
    fs.appendFileSync(file, value + "\n", { mode: 0o600 });
  return { ok: true, kind, value };
}
export function localCommand(root, command) {
  const match = String(command)
    .trim()
    .match(/^(?:\/)?(priority|prioritize|ignore)(?:\s+add)?\s+(.{1,200})$/i);
  if (!match) throw Error("Use: priority add Name or ignore Name");
  return addRule(
    root,
    match[1].toLowerCase() === "ignore" ? "ignore" : "priority",
    match[2],
  );
}
export function readAccounts(root) {
  const p = path.join(root, "email-accounts.json");
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(a) || a.length > 20) throw Error("Invalid account list");
  return a;
}
