import fs from "node:fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
const logger = {
  level: "silent",
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
import { whatsappContent } from "./whatsapp-content.js";
export const messageText = (message) => whatsappContent(message).text;
export class WhatsAppReader {
  constructor({ root, onMessage, onStatus, onContact, knownContacts = [] }) {
    this.root = root;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.groups = new Map(
      knownContacts
        .filter((c) => c.id.endsWith("@g.us"))
        .map((c) => [c.id, c.name]),
    );
    this.contacts = new Map(knownContacts.map((c) => [c.id, c.name]));
    this.onContact = onContact;
    this.closed = true;
    this.tries = 0;
    this.status = { state: "not-linked" };
  }
  update(data) {
    Object.assign(this.status, data);
    this.onStatus?.({ ...this.status });
  }
  async start() {
    if (!this.closed && this.sock) return;
    this.closed = false;
    fs.mkdirSync(this.root, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.root);
    this.sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu("June"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    this.sock.ev.on("creds.update", saveCreds);
    const saveContacts = (items) => {
      for (const c of items) {
        const name = c.name || c.notify || c.verifiedName;
        if (name)
          for (const id of [c.id, c.lid, c.phoneNumber].filter(Boolean)) {
            this.contacts.set(id, name);
            this.onContact?.(id, name);
          }
      }
    };
    this.sock.ev.on("contacts.upsert", saveContacts);
    this.sock.ev.on("contacts.update", saveContacts);
    this.sock.ev.on("connection.update", async (u) => {
      if (u.qr)
        this.update({
          state: "scan-qr",
          qr: await QRCode.toDataURL(u.qr, { width: 280, margin: 2 }),
        });
      if (u.connection === "open") {
        this.tries = 0;
        this.update({ state: "connected", qr: null });
        try {
          for (const [id, g] of Object.entries(
            await this.sock.groupFetchAllParticipating(),
          )) {
            this.groups.set(id, g.subject);
            this.onContact?.(id, g.subject);
          }
        } catch {}
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          this.update({ state: "link-expired", qr: null });
          this.closed = true;
          return;
        }
        this.update({
          state: this.closed ? "stopped" : "reconnecting",
          qr: null,
        });
        if (!this.closed) {
          const delay = Math.min(60000, 3000 * 2 ** Math.min(this.tries++, 5));
          this.timer = setTimeout(
            () =>
              this.start().catch(() =>
                this.update({ state: "connection-failed" }),
              ),
            delay,
          );
        }
      }
    });
    this.sock.ev.on("groups.update", (groups) => {
      for (const g of groups)
        if (g.subject) {
          this.groups.set(g.id, g.subject);
          this.onContact?.(g.id, g.subject);
        }
    });
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (!["notify", "append"].includes(type) || this.closed) return;
      for (const m of messages) {
        const chat = m.key?.remoteJid ?? "";
        if (
          chat === "status@broadcast" ||
          chat.endsWith("@newsletter") ||
          !m.key?.id
        )
          continue;
        const content = whatsappContent(m.message);
        if (!content.text && !content.attachments.length) continue;
        if (chat.endsWith("@g.us") && !this.groups.has(chat)) {
          try {
            const metadata = await this.sock.groupMetadata(chat);
            this.groups.set(chat, metadata.subject);
            this.onContact?.(chat, metadata.subject);
          } catch {
            this.update({
              warning:
                "Group metadata unavailable; unknown group message skipped before storage",
            });
            continue;
          }
        }
        if (this.closed) break;
        this.onMessage({
          source: "whatsapp",
          account: "personal",
          externalId: chat + ":" + m.key.id,
          receivedAt: new Date(
            Number(m.messageTimestamp ?? Date.now() / 1000) * 1000,
          ).toISOString(),
          sender: m.key.fromMe
            ? (this.sock.user?.id ?? "self")
            : (m.key.participant ?? chat),
          senderName: m.key.fromMe
            ? "You"
            : (this.contacts.get(m.key.participant ?? chat) ??
              m.pushName ??
              ""),
          chatId: chat,
          chatName:
            this.groups.get(chat) ??
            this.contacts.get(chat) ??
            (!m.key.fromMe ? m.pushName : "") ??
            "",
          text: content.text,
          attachments: content.attachments,
          metadataComplete: true,
          direction: m.key.fromMe ? "outgoing" : "incoming",
        });
      }
    });
    this.update({ state: state.creds.registered ? "connecting" : "linking" });
  }
  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    this.sock?.end(new Error("June stopped"));
    this.sock = null;
    this.update({ state: "stopped", qr: null });
  }
}
