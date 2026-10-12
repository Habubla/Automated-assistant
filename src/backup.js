import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { ValidationError } from "./errors.js";
import {
  assertNoLinks,
  inside,
  sha256,
  safeId,
  writeJsonAtomic,
  readJson,
  withVaultLock,
} from "./util.js";

async function inventory(root, relative = "", out = []) {
  const dir = inside(root, relative);
  await assertNoLinks(dir);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      e.name === ".git" ||
      e.name === "node_modules" ||
      e.name === ".june-memory-lock.sqlite" ||
      e.name.startsWith(".june-memory-lock.sqlite-") ||
      e.name.endsWith(".tmp")
    )
      continue;
    if (e.isSymbolicLink())
      throw new ValidationError("Backup refuses symbolic links.");
    const rel = path.join(relative, e.name);
    if (e.isDirectory()) await inventory(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
async function copyFiles(source, dest, prefix, manifest) {
  for (const rel of await inventory(source)) {
    const file = inside(source, rel),
      target = inside(dest, path.join(prefix, rel));
    const before = await fs.readFile(file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, before, { flag: "wx", mode: 0o600 });
    if (
      sha256(before) !== sha256(await fs.readFile(target)) ||
      sha256(before) !== sha256(await fs.readFile(file))
    )
      throw new ValidationError(
        "Source changed during backup; incomplete snapshot retained.",
      );
    manifest.push({
      path: path.join(prefix, rel).replaceAll("\\", "/"),
      size: before.length,
      sha256: sha256(before),
    });
  }
}
export async function verifyBackup(root) {
  await assertNoLinks(root);
  const manifest = await readJson(path.join(root, "manifest.json"));
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new ValidationError("Backup manifest missing or invalid.");
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || seen.has(entry.path))
      throw new ValidationError("Invalid backup path.");
    seen.add(entry.path);
    const file = inside(root, entry.path);
    await assertNoLinks(file);
    const bytes = await fs.readFile(file);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
      throw new ValidationError("Backup integrity mismatch.");
  }
  for (const entry of manifest.files.filter(
    (x) =>
      x.path.endsWith(".sqlite") &&
      (x.path.startsWith("openclaw/databases/") ||
        x.path.startsWith("june-private/databases/")),
  )) {
    const db = new DatabaseSync(inside(root, entry.path), { readOnly: true });
    try {
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new ValidationError("SQLite backup integrity failed.");
    } finally {
      db.close();
    }
  }
  return { ok: true, files: manifest.files.length };
}
export async function createBackup({
  vault,
  backupRoot,
  openclawRoot = null,
  engineRoot = null,
  settingsRoot = null,
  hubRoot = null,
  n8nRoot = null,
  serviceSecretsFile = null,
  researchRoot = null,
}) {
  const backupPath = path.resolve(backupRoot),
    rel = path.relative(vault.root, backupPath);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new ValidationError("Backup destination must be outside the vault.");
  await assertNoLinks(backupPath);
  await fs.mkdir(backupPath, { recursive: true });
  const id =
      "backup-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8),
    dest = inside(backupPath, id);
  await fs.mkdir(dest);
  const files = [];
  await withVaultLock(vault.root, () =>
    copyFiles(vault.root, dest, "vault", files),
  );
  if (engineRoot) {
    // Engine source only; runtime dependencies, secrets, Git internals and execution data are excluded.
    for (const rel of [
      "src",
      "scripts",
      "docs",
      "test",
      "automation/n8n/workflows",
      "automation/n8n/managed-workflows",
      "integrations",
      "ui",
    ]) {
      const source = inside(engineRoot, rel);
      if (await fs.stat(source).catch(() => null))
        await copyFiles(source, dest, "engine/" + rel, files);
    }
    for (const rel of ["package.json", "package-lock.json", "README.md"]) {
      const file = inside(engineRoot, rel);
      if (await fs.stat(file).catch(() => null)) {
        const bytes = await fs.readFile(file);
        const target = inside(dest, "engine/" + rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        files.push({
          path: "engine/" + rel,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  if (settingsRoot)
    await copyFiles(settingsRoot, dest, "june-private/settings", files);
  if (hubRoot) {
    await assertNoLinks(hubRoot);
    const source = inside(hubRoot, "hub.sqlite");
    if (await fs.stat(source).catch(() => null)) {
      const rel = "june-private/databases/hub.sqlite",
        target = inside(dest, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await sqliteBackup(db, target);
      } finally {
        db.close();
      }
      const bytes = await fs.readFile(target);
      files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    }
    // WhatsApp linked-device keys are copied only when stable across the snapshot.
    const wa = inside(hubRoot, "whatsapp");
    if (await fs.stat(wa).catch(() => null))
      await copyFiles(wa, dest, "june-private/whatsapp", files);
  }
  if (researchRoot && (await fs.stat(researchRoot).catch(() => null)))
    await copyFiles(researchRoot, dest, "june-private/research", files);
  if (serviceSecretsFile) {
    await assertNoLinks(serviceSecretsFile);
    const bytes = await fs.readFile(serviceSecretsFile);
    const rel = "june-private/service-secrets.json",
      target = inside(dest, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
  }
  if (n8nRoot) {
    await assertNoLinks(n8nRoot);
    const source = inside(n8nRoot, "database.sqlite");
    if (await fs.stat(source).catch(() => null)) {
      const rel = "june-private/databases/n8n.sqlite",
        target = inside(dest, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await sqliteBackup(db, target);
      } finally {
        db.close();
      }
      const bytes = await fs.readFile(target);
      files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  if (openclawRoot) {
    await assertNoLinks(openclawRoot);
    const configDir = inside(dest, "openclaw/config");
    await fs.mkdir(configDir, { recursive: true });
    for (const entry of await fs.readdir(openclawRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/^openclaw\.json(?:\.|$)/.test(entry.name))
        continue;
      const source = inside(openclawRoot, entry.name);
      await assertNoLinks(source);
      const bytes = await fs.readFile(source);
      await fs.writeFile(inside(configDir, entry.name), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      files.push({
        path: "openclaw/config/" + entry.name,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    const agentRoot = inside(openclawRoot, "agents");
    const all = await inventory(agentRoot);
    for (const rel of all.filter((x) => x.endsWith("openclaw-agent.sqlite"))) {
      const source = inside(agentRoot, rel),
        targetRel = "openclaw/databases/" + rel.replaceAll("\\", "/"),
        target = inside(dest, targetRel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await sqliteBackup(db, target);
      } finally {
        db.close();
      }
      const bytes = await fs.readFile(target);
      files.push({
        path: targetRel,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    const globalState = inside(openclawRoot, "state");
    if (await fs.stat(globalState).catch(() => null))
      for (const rel of (await inventory(globalState)).filter((x) =>
        x.endsWith(".sqlite"),
      )) {
        const source = inside(globalState, rel),
          targetRel =
            "openclaw/databases/global-state/" + rel.replaceAll("\\", "/"),
          target = inside(dest, targetRel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const db = new DatabaseSync(source, { readOnly: true });
        try {
          await sqliteBackup(db, target);
        } finally {
          db.close();
        }
        const bytes = await fs.readFile(target);
        files.push({
          path: targetRel,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    // Legacy session exports remain separate from consistent online database snapshots.
    for (const rel of all.filter(
      (x) =>
        /\.(jsonl|json)$/.test(x) && x.split(path.sep).includes("sessions"),
    )) {
      const bytes = await fs.readFile(inside(agentRoot, rel)),
        name = "openclaw/sessions/" + rel.replaceAll("\\", "/");
      const target = inside(dest, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  await writeJsonAtomic(
    path.join(dest, "manifest.json"),
    { schemaVersion: 1, id, createdAt: new Date().toISOString(), files },
    { overwrite: false },
  );
  const verified = await verifyBackup(dest);
  return { id, path: dest, ...verified };
}
export async function restoreVault({ backupPath, target }) {
  await verifyBackup(backupPath);
  await assertNoLinks(target);
  if (
    await fs
      .stat(target)
      .catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)))
  )
    throw new ValidationError(
      "Restore requires a new, non-existing test directory.",
    );
  const manifest = await readJson(path.join(backupPath, "manifest.json"));
  const vaultEntries = manifest.files.filter((x) =>
    x.path.startsWith("vault/"),
  );
  if (!vaultEntries.length)
    throw new ValidationError("Backup contains no vault.");
  await fs.mkdir(target, { recursive: true });
  for (const entry of vaultEntries) {
    const dest = inside(target, entry.path.slice(6));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(
      inside(backupPath, entry.path),
      dest,
      fs.constants.COPYFILE_EXCL,
    );
  }
  const result = await new Vault(target).validate();
  if (!result.ok)
    throw new ValidationError("Restored vault failed validation.");
  return { ok: true, files: vaultEntries.length, records: result.records };
}
