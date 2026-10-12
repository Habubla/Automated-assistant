const $ = (selector) => document.querySelector(selector);
const mail = location.pathname === "/mail",
  label = mail ? "Mail" : "Messages";
let items = [],
  selected = null,
  messages = [],
  next = false,
  threadMore = false,
  filter = "focused",
  account = "",
  search = "",
  loading = false,
  searchTimer,
  summaryVersion = 0;
const node = (tag, content, cls) => {
  const n = document.createElement(tag);
  if (content !== undefined) n.textContent = content;
  if (cls) n.className = cls;
  return n;
};
const notify = (text) => ($("#notice").textContent = text);
const date = (value, options = {}) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    ...options,
  }).format(new Date(value));
const shortDate = (value) => date(value, { day: "numeric", month: "short" });
async function api(url, body) {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-june-action": "1" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok || data.ok === false)
    throw Error(data.error ?? data.status ?? "REQUEST_FAILED");
  return data;
}
const errorMessage = (error) =>
  ({
    OPEN_FROM_START_JUNE:
      "Open this window using the June Messages or June Mail desktop button.",
    LOCAL_MODEL_BUSY: "The local model is already working. Try again shortly.",
    LOCAL_MODEL_UNAVAILABLE:
      "The local model could not finish. Your messages remain available; try again after it finishes other work.",
  })[error.message] ?? error.message.replaceAll("_", " ");
const badge = (category) => node("span", category, "badge " + category);
function media(container, attachments) {
  if (!attachments?.length) return;
  const row = node("div", undefined, "attachments");
  const names = {
    image: "Photo attached",
    video: "Video attached",
    audio: "Audio attached",
    document: "Document attached",
    sticker: "Sticker attached",
    file: "Media attached",
  };
  for (const a of attachments) {
    const chip = node("div", undefined, "attachment"),
      icon = node("span", "▧", "attachment-icon"),
      text = node("div", a.name || names[a.kind] || "Media attached");
    text.append(
      node(
        "small",
        names[a.kind] +
          (a.size
            ? " · " +
              (a.size >= 1048576
                ? (a.size / 1048576).toFixed(1) + " MB"
                : Math.ceil(a.size / 1024) + " KB")
            : ""),
      ),
    );
    chip.append(icon, text);
    row.append(chip);
  }
  container.append(row);
}
function renderList() {
  const list = $("#list");
  list.replaceChildren();
  for (const item of items) {
    const id = mail ? item.id : item.thread_id,
      name = mail ? item.sender_name || item.sender : item.display_name;
    const button = node(
      "button",
      undefined,
      "entry" + (id === selected ? " selected" : ""),
    );
    button.setAttribute("aria-pressed", String(id === selected));
    const avatar = node(
      "span",
      name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0])
        .join("")
        .toUpperCase() || "?",
      "avatar",
    );
    const main = node("span", undefined, "entry-main"),
      top = node("span", undefined, "entry-top");
    top.append(
      node(
        "span",
        (item.thread_priority || item.priority ? "★ " : "") + name,
        "entry-name",
      ),
      node("time", shortDate(item.received_at), "entry-time"),
    );
    main.append(
      top,
      node(
        "span",
        mail
          ? item.subject || "(No subject)"
          : item.preview || "Media attached",
        "preview",
      ),
    );
    const tags = node("span", undefined, "tagline");
    if (mail) tags.append(badge(item.category));
    else
      tags.append(
        node("span", item.isGroup ? "Group" : "Conversation"),
        node("span", item.message_count + " messages", "count"),
      );
    if (item.attachments.length) tags.append(node("span", "▧ Attachment"));
    main.append(tags);
    button.append(avatar, main);
    button.addEventListener("click", () => choose(id));
    list.append(button);
  }
  if (!items.length)
    list.append(
      node(
        "p",
        search
          ? "No matching results."
          : mail
            ? "No mail in this filter yet. Try All, or check your connection in the dashboard."
            : "New messages will appear here while WhatsApp is connected.",
        "list-empty",
      ),
    );
  $("#list-count").textContent =
    items.length +
    (next ? "+" : "") +
    " " +
    (mail ? "emails" : "conversations");
  $("#more-list").hidden = !next;
}
function renderMessages(scrollToEnd = false) {
  const viewport = $("#message-scroll"),
    nearEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120;
  const target = $("#messages");
  target.replaceChildren();
  let day = "";
  for (const m of messages) {
    const current = date(m.received_at, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    if (current !== day) {
      target.append(node("div", current, "date-divider"));
      day = current;
    }
    const bubble = node(
      "article",
      undefined,
      "bubble" + (m.direction === "outgoing" ? " outgoing" : ""),
    );
    bubble.append(
      node(
        "div",
        m.direction === "outgoing" ? "You" : m.sender_name || m.sender,
        "sender-label",
      ),
    );
    if (m.body !== "Media attached")
      bubble.append(node("p", m.body, "message-body"));
    media(bubble, m.attachments);
    bubble.append(
      node(
        "div",
        date(m.received_at, { hour: "numeric", minute: "2-digit" }),
        "message-time",
      ),
    );
    target.append(bubble);
  }
  $("#older").hidden = !threadMore;
  if (scrollToEnd || nearEnd) viewport.scrollTop = viewport.scrollHeight;
}
function renderEmail(m) {
  const target = $("#messages");
  target.replaceChildren();
  $("#older").hidden = true;
  const article = node("article", undefined, "mail-card"),
    meta = node("div", undefined, "mail-meta");
  meta.append(
    node("strong", m.sender_name || m.sender),
    node("div", "From: " + m.sender),
    node("div", "Mailbox: " + m.account),
    node(
      "div",
      date(m.received_at, {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ),
  );
  meta.append(badge(m.category));
  if (m.ai_note) meta.append(node("p", "Local AI: " + m.ai_note, "ai-note"));
  article.append(meta, node("p", m.body, "message-body"));
  media(article, m.attachments);
  if (!m.metadata_version)
    article.append(
      node(
        "p",
        "Attachment details for this older message will update during collection.",
        "ai-note",
      ),
    );
  target.append(article);
  $("#message-scroll").scrollTop = 0;
}
async function choose(id) {
  if (!id) return;
  const changed = selected !== id;
  selected = id;
  if (changed) {
    summaryVersion++;
    messages = [];
    $("#local-summary").hidden = true;
  }
  renderList();
  $("#empty").hidden = true;
  $("#opened").hidden = false;
  $("#classify-button").hidden = !mail;
  try {
    if (mail) {
      const data = await api("/api/inbox/item?id=" + encodeURIComponent(id));
      if (selected !== id) return;
      const m = data.item;
      $("#detail-kicker").textContent = "EMAIL";
      $("#detail-name").textContent = m.subject || "(No subject)";
      $("#detail-subtitle").textContent = m.sender_name || m.sender;
      messages = [m];
      renderEmail(m);
    } else {
      const item = items.find((i) => i.thread_id === id);
      $("#detail-kicker").textContent = item?.isGroup
        ? "WHATSAPP GROUP"
        : "WHATSAPP";
      $("#detail-name").textContent = item?.display_name || "Conversation";
      $("#detail-subtitle").textContent =
        "Messages collected by June · timestamps in IST";
      const data = await api("/api/inbox/thread?id=" + encodeURIComponent(id));
      if (selected !== id) return;
      messages = data.items;
      threadMore = data.hasMore;
      renderMessages(true);
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}
async function loadList(append = false) {
  const params = new URLSearchParams({ q: search, limit: "60" });
  if (mail) {
    params.set("account", account);
    params.set("category", filter);
    if (append && items.length) params.set("before", items.at(-1).id);
  } else if (append) params.set("offset", String(items.length));
  const data = await api(
    "/api/inbox/" + (mail ? "mail" : "chats") + "?" + params,
  );
  const combined = append ? [...items, ...data.items] : data.items;
  const unique = new Map(combined.map((r) => [mail ? r.id : r.thread_id, r]));
  items = [...unique.values()];
  next = data.hasMore;
  renderList();
  if (!selected && items.length)
    await choose(mail ? items[0].id : items[0].thread_id);
}
async function status() {
  const s = await api("/api/inbox/status");
  if (mail) {
    const connected = s.mail.filter((a) => a.status === "connected").length;
    $("#connection").textContent =
      connected +
      " mailbox" +
      (connected === 1 ? "" : "es") +
      " connected · checks every 5 minutes";
    const select = $("#account");
    if (select.options.length === 1)
      for (const a of s.accounts) {
        if (a.configured) {
          const option = node("option", a.email);
          option.value = a.email;
          select.append(option);
        }
      }
  } else
    $("#connection").textContent =
      "WhatsApp " +
      s.whatsapp.state.replaceAll("-", " ") +
      (s.whatsapp.warning ? " · " + s.whatsapp.warning : "");
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    await status();
    if (items.length <= 60) await loadList();
    if (selected && !mail) {
      const id = selected,
        data = await api("/api/inbox/thread?id=" + encodeURIComponent(id));
      if (selected === id) {
        const merged = new Map(
          [...messages, ...data.items].map((m) => [m.id, m]),
        );
        messages = [...merged.values()].sort(
          (a, b) =>
            a.received_at.localeCompare(b.received_at) ||
            a.id.localeCompare(b.id),
        );
        if (messages.length <= 50) threadMore = data.hasMore;
        renderMessages();
      }
    }
    return true;
  } catch (error) {
    notify(errorMessage(error));
    return false;
  } finally {
    loading = false;
  }
}
$("#heading").textContent = label;
$("#section-kicker").textContent = mail ? "YOUR INBOX" : "WHATSAPP";
document.title = "June " + label;
$("#mail-controls").hidden = !mail;
$("#search").placeholder = mail
  ? "Search sender, subject or message"
  : "Find a person or group";
$("#empty-description").textContent = mail
  ? "Choose an email to read it in a calmer space."
  : "Choose a conversation to read its messages here.";
$("#detail-footer").textContent = mail
  ? "Read-only mail · Opening here does not mark your original email as read · Attachments are labels only"
  : "Read-only view · Media stays in WhatsApp · No read receipts sent";
$("#other-window").textContent = mail ? "Open Messages ↗" : "Open Mail ↗";
$("#other-window").addEventListener("click", () =>
  window.open(
    mail ? "/messages" : "/mail",
    mail ? "JuneMessages" : "JuneMail",
    "width=1320,height=900",
  ),
);
$("#refresh").addEventListener("click", () => {
  notify("Refreshing saved messages…");
  items = [];
  refresh().then((ok) => {
    if (ok) notify("Inbox refreshed.");
  });
});
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    search = $("#search").value;
    items = [];
    try {
      await loadList();
    } catch (e) {
      notify(errorMessage(e));
    }
  }, 250);
});
$("#account").addEventListener("change", async () => {
  account = $("#account").value;
  selected = null;
  items = [];
  $("#opened").hidden = true;
  $("#empty").hidden = false;
  await refresh();
});
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", async () => {
    filter = button.dataset.filter;
    selected = null;
    items = [];
    $("#opened").hidden = true;
    $("#empty").hidden = false;
    for (const b of document.querySelectorAll("[data-filter]"))
      b.classList.toggle("selected", b === button);
    await refresh();
  });
$("#more-list").addEventListener("click", async () => {
  try {
    await loadList(true);
  } catch (e) {
    notify(errorMessage(e));
  }
});
$("#older").addEventListener("click", async () => {
  if (!messages.length) return;
  const id = selected,
    viewport = $("#message-scroll"),
    height = viewport.scrollHeight;
  try {
    const data = await api(
      "/api/inbox/thread?" +
        new URLSearchParams({ id, before: messages[0].id }),
    );
    if (selected !== id) return;
    messages = [...data.items, ...messages];
    threadMore = data.hasMore;
    renderMessages();
    viewport.scrollTop = viewport.scrollHeight - height;
  } catch (e) {
    notify(errorMessage(e));
  }
});
$("#dismiss-summary").addEventListener(
  "click",
  () => ($("#local-summary").hidden = true),
);
$("#summary-button").addEventListener("click", async () => {
  const id = selected,
    version = summaryVersion,
    button = $("#summary-button");
  if (!id) return;
  button.disabled = true;
  button.textContent = "Summarizing…";
  notify(
    "The local 4B model is reading up to 20 messages. The first run may take a minute.",
  );
  try {
    const result = await api(
      "/api/inbox/summarize",
      mail ? { id } : { threadId: id },
    );
    if (selected === id && summaryVersion === version) {
      $("#summary-text").textContent = result.summary;
      $("#local-summary").hidden = false;
      notify("Summary prepared locally. No Gemini request was used.");
    }
  } catch (e) {
    notify(errorMessage(e));
  } finally {
    button.disabled = false;
    button.textContent = "Summarize locally";
  }
});
$("#classify-button").addEventListener("click", async () => {
  const id = selected,
    button = $("#classify-button");
  if (!id) return;
  button.disabled = true;
  notify("Sorting this email with the local model…");
  try {
    await api("/api/inbox/classify", { id });
    await loadList();
    if (selected === id) await choose(id);
    notify("Local sorting complete. The original email is unchanged.");
  } catch (e) {
    notify(errorMessage(e));
  } finally {
    button.disabled = false;
  }
});
try {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname);
    await api("/api/login", { token });
  }
  if (await refresh())
    notify(
      mail
        ? "Focused mail hides promotions. Use the filters to see everything."
        : "Showing messages June has collected. Media is labelled; attachment files stay in WhatsApp.",
    );
} catch (error) {
  notify(errorMessage(error));
}
setInterval(refresh, 12000);
