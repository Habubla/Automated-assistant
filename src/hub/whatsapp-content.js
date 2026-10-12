import { normalizeMessageContent } from "@whiskeysockets/baileys";
export function whatsappContent(message) {
  const body = normalizeMessageContent(message) ?? {};
  const text =
    body.conversation ??
    body.extendedTextMessage?.text ??
    body.imageMessage?.caption ??
    body.videoMessage?.caption ??
    body.documentMessage?.caption ??
    "";
  const attachments = [];
  for (const [field, kind] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ]) {
    const media = body[field];
    if (!media) continue;
    const size = Number(media.fileLength);
    attachments.push({
      kind,
      name:
        media.fileName ??
        (field === "audioMessage" && media.ptt ? "Voice message" : ""),
      mime: media.mimetype ?? "",
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    });
  }
  return { text, attachments };
}
