import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
export function structureAttachments(node, result = []) {
  if (!node) return result;
  const name =
    node.dispositionParameters?.filename ?? node.parameters?.name ?? "";
  if (
    node.disposition === "attachment" ||
    name ||
    (/^(image|audio|video)\//.test(node.type) && !node.childNodes?.length)
  ) {
    const prefix = node.type?.split("/")[0];
    result.push({
      kind: ["image", "audio", "video"].includes(prefix) ? prefix : "document",
      name,
      mime: node.type,
      size: node.size,
    });
  }
  for (const child of node.childNodes ?? [])
    structureAttachments(child, result);
  return result;
}
export async function collectMail({
  account,
  store,
  rules,
  clientFactory = (o) => new ImapFlow(o),
}) {
  if (!account.enabled) return { account: account.id, status: "not-connected" };
  if (
    !account.host ||
    !account.email ||
    (!account.appPassword && !account.accessToken)
  )
    return { account: account.id, status: "credentials-required" };
  const client = clientFactory({
    host: account.host,
    port: 993,
    secure: true,
    auth: {
      user: account.email,
      ...(account.accessToken
        ? { accessToken: account.accessToken }
        : { pass: account.appPassword }),
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true },
  });
  client.on?.("error", () => {});
  let lock,
    added = 0,
    skipped = 0,
    metadataUpdated = 0;
  try {
    await client.connect();
    lock = await client.getMailboxLock(account.folder ?? "INBOX", {
      readOnly: true,
    });
    const validity = String(client.mailbox.uidValidity),
      key = "mail:" + account.id + ":" + validity;
    let checkpoint = store.get(key, 0);
    const found = (
      await client.search(
        checkpoint
          ? { uid: checkpoint + 1 + ":*" }
          : { since: new Date(Date.now() - 7 * 86400000) },
        { uid: true },
      )
    )
      .filter((uid) => uid > checkpoint)
      .sort((a, b) => a - b)
      .slice(0, 30);
    // Enrich existing messages without rewinding collection or changing read flags.
    const legacy = store.db
      .prepare(
        "SELECT external_id FROM inbox WHERE source='email' AND account=? AND metadata_version=0 LIMIT 30",
      )
      .all(account.email)
      .filter((r) => r.external_id.startsWith(validity + ":"))
      .map((r) => Number(r.external_id.split(":")[1]))
      .filter(Number.isSafeInteger);
    const uids = [...new Set([...found, ...legacy])].slice(0, 30);
    for (const uid of uids) {
      const meta = await client.fetchOne(
        uid,
        { size: true, envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      if (!meta) {
        skipped++;
        if (uid > checkpoint) {
          checkpoint = uid;
          store.set(key, uid);
        }
        continue;
      }
      let input;
      if (meta.size > 1000000) {
        const from = meta.envelope?.from?.[0] ?? {};
        input = {
          receivedAt: (
            meta.internalDate ??
            meta.envelope?.date ??
            new Date()
          ).toISOString(),
          sender: from.address ?? "",
          senderName: from.name ?? "",
          subject: meta.envelope?.subject ?? "",
          text: "Large email: open your original mailbox to read the full message. Attachment details are shown below.",
          attachments: structureAttachments(meta.bodyStructure),
          promotional: false,
        };
      } else {
        const message = await client.fetchOne(
          uid,
          { source: true, internalDate: true },
          { uid: true },
        );
        if (!message?.source) throw Error("MAIL_SOURCE_UNAVAILABLE");
        const parsed = await simpleParser(message.source, {
          skipHtmlToText: false,
          skipTextToHtml: true,
          skipImageLinks: true,
        });
        const from = parsed.from?.value?.[0] ?? {};
        input = {
          receivedAt: (
            parsed.date ??
            message.internalDate ??
            new Date()
          ).toISOString(),
          sender: from.address ?? "",
          senderName: from.name ?? "",
          subject: parsed.subject ?? "",
          text: (parsed.text ?? "").slice(0, 15000),
          attachments: (parsed.attachments ?? []).map((a) => ({
            kind: /^(image|audio|video)\//.test(a.contentType)
              ? a.contentType.split("/")[0]
              : "document",
            name: a.filename ?? "",
            mime: a.contentType,
            size: a.size,
          })),
          promotional:
            !!parsed.headers.get("list-unsubscribe") &&
            !/deadline|assignment|internship|competition|opportunit|research|scholarship/i.test(
              parsed.subject ?? "",
            ),
        };
      }
      const result = store.ingest(
        {
          source: "email",
          account: account.email,
          externalId: validity + ":" + uid,
          ...input,
          metadataComplete: true,
        },
        rules,
      );
      if (result.replayed) metadataUpdated++;
      else if (!result.skipped) added++;
      if (uid > checkpoint) {
        checkpoint = uid;
        store.set(key, uid);
      }
    }
    return {
      account: account.id,
      status: "connected",
      added,
      skipped,
      metadataUpdated,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    lock?.release();
    try {
      await client.logout();
    } catch {
      client.close?.();
    }
  }
}
