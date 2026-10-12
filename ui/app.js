const $ = (s) => document.querySelector(s);
let latest = null,
  refreshing = false;
const el = (tag, value, className) => {
  const n = document.createElement(tag);
  if (value !== undefined) n.textContent = value;
  if (className) n.className = className;
  return n;
};
function notice(message) {
  $("#notice").textContent = message;
}
async function api(url, body) {
  const r = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-june-action": "1" },
          body: JSON.stringify(body),
        }),
  });
  const d = await r.json();
  if (!r.ok || d.ok === false)
    throw Error(d.error ?? d.status ?? "Operation unavailable");
  return d;
}
const action = (button, fn) => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fn();
      await refresh();
    } catch (e) {
      notice(e.message.replaceAll("_", " "));
    } finally {
      button.disabled = false;
    }
  });
};
function linkText(container, text) {
  let last = 0;
  for (const m of text.matchAll(/https:\/\/[^\s<>"\])}]+/g)) {
    container.append(document.createTextNode(text.slice(last, m.index)));
    const a = el("a", m[0]);
    a.href = m[0];
    a.target = "_blank";
    a.rel = "noreferrer";
    container.append(a);
    last = m.index + m[0].length;
  }
  container.append(document.createTextNode(text.slice(last)));
}
function empty(container, message) {
  if (!container.children.length) container.append(el("p", message, "empty"));
}
function render(s) {
  latest = s;
  $("#services").replaceChildren(
    ...s.services.map((x) => {
      const n = el("div", undefined, "service");
      n.append(
        el("span", undefined, "dot" + (x.ok ? " ok" : "")),
        document.createTextNode(x.name + " · " + (x.ok ? "Ready" : "Offline")),
      );
      return n;
    }),
  );
  $("#activity").textContent = s.running.length
    ? "Working: " + s.running.join(", ")
    : "Ready for new messages";
  $("#rules").textContent =
    "Priority: " +
    (s.rules.priority.join(", ") || "none yet") +
    " · Ignore: " +
    (s.rules.ignore.join(", ") || "none");
  const active = $("#active");
  active.replaceChildren();
  for (const r of s.active ?? []) {
    const n = el("div", undefined, "item");
    n.append(
      el("h3", r.claim),
      el(
        "p",
        r.type + (r.dueAt ? " · " + new Date(r.dueAt).toLocaleString() : ""),
        "meta",
      ),
    );
    const done = el("button", "Mark complete", "secondary");
    action(done, () =>
      api("/api/active", {
        id: r.id,
        revision: r.revision,
        status: "completed",
      }),
    );
    n.append(done);
    active.append(n);
  }
  empty(active, "No confirmed commitments yet.");
  const reviews = $("#reviews");
  reviews.replaceChildren();
  for (const r of s.review) {
    const n = el("article", undefined, "item");
    n.append(
      el("h3", r.claim),
      el(
        "p",
        (r.suggestedActive?.type ?? "Observation") +
          (r.suggestedActive?.dueAt
            ? " · Due " + new Date(r.suggestedActive.dueAt).toLocaleString()
            : ""),
        "meta",
      ),
      el("p", r.evidence?.map((e) => e.quote).join("\n") ?? "", "quote"),
    );
    const row = el("div", undefined, "row");
    const confirm = el(
        "button",
        r.suggestedActive ? "Confirm & track" : "Confirm",
      ),
      reject = el("button", "Dismiss", "secondary");
    action(confirm, () =>
      api("/api/review", {
        id: r.id,
        revision: r.revision,
        verdict: "confirmed",
        activate: !!r.suggestedActive,
      }),
    );
    action(reject, () =>
      api("/api/review", {
        id: r.id,
        revision: r.revision,
        verdict: "rejected",
      }),
    );
    row.append(confirm, reject);
    n.append(row);
    reviews.append(n);
  }
  empty(
    reviews,
    "No candidates waiting. Collected messages will appear here when the local worker finds a deadline or commitment.",
  );
  const messages = $("#messages");
  messages.replaceChildren();
  $("#inbox-count").textContent = s.inbox.length + " recent items";
  for (const m of s.inbox) {
    const n = el("details", undefined, "item");
    n.append(
      el(
        "summary",
        (m.priority ? "★ " : "") +
          (m.subject || m.chat_name || m.sender_name || m.sender) +
          " · " +
          m.category +
          " · " +
          m.status,
      ),
      el(
        "p",
        m.source +
          " · " +
          m.account +
          " · " +
          new Date(m.received_at).toLocaleString(),
        "meta",
      ),
      el("p", m.body),
    );
    if (m.source === "whatsapp") {
      const row = el("div", undefined, "row"),
        p = el("button", "Prioritize sender", "secondary"),
        i = el("button", "Ignore this chat", "secondary");
      action(p, () =>
        api("/api/command", { command: "priority add " + m.sender }),
      );
      action(i, () =>
        api("/api/command", { command: "ignore " + (m.chat_id || m.sender) }),
      );
      row.append(p, i);
      n.append(row);
    }
    messages.append(n);
  }
  empty(
    messages,
    "Connect your inboxes or WhatsApp below. Existing messages stay unchanged in their original apps.",
  );
  const briefs = $("#briefs");
  briefs.replaceChildren();
  for (const r of s.research) {
    const n = el("details", undefined, "item");
    n.append(el("summary", r.title + " · " + r.status));
    const report = el("div", undefined, "report");
    linkText(
      report,
      r.result ||
        ({
          GEMINI_QUOTA_EXHAUSTED:
            "Gemini quota exhausted. Your request is saved. Add available project keys or wait for quota reset.",
          SEARCH_PROVIDER_CHALLENGE:
            "Search provider requested a browser challenge. No verified result is available.",
          RESEARCH_UNAVAILABLE_OR_UNVERIFIED:
            "Research did not finish with verified sources. Your request is saved for retry.",
        }[r.error] ??
          r.error) ||
        r.brief,
    );
    n.append(report);
    if (["needs-attention", "needs-review", "retry"].includes(r.status)) {
      const retry = el(
        "button",
        "Retry after fixing connection or quota",
        "secondary",
      );
      action(retry, () => api("/api/retry-research", { id: r.id }));
      n.append(retry);
    }
    briefs.append(n);
  }
  empty(
    briefs,
    "Your daily opportunity brief and task resource packs will appear here.",
  );
  const accounts = $("#accounts");
  if (!accounts.children.length) {
    for (const a of s.accounts) {
      const row = el("form", undefined, "account");
      const label = el("div", a.email);
      label.append(
        el(
          "small",
          a.configured ? "Authorization saved" : "Authorization needed",
        ),
      );
      const input = el("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = "Google app password";
      input.setAttribute("aria-label", "App password for " + a.email);
      const button = el("button", "Connect");
      row.append(label, input, button);
      row.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api("/api/mail", { id: a.id, appPassword: input.value });
          input.value = "";
          label.querySelector("small").textContent = "Authorization saved";
          notice("Mailbox saved. June will check it automatically.");
        } catch (e) {
          notice(e.message.replaceAll("_", " "));
        }
      });
      accounts.append(row);
    }
  }
  for (const a of s.accounts) {
    const row = [...accounts.children].find(
      (row) => row.firstChild.firstChild.textContent === a.email,
    );
    if (row) {
      const status = s.mail.find((m) => m.account === a.id);
      row.querySelector("small").textContent =
        status?.status ??
        (a.configured ? "Authorization saved" : "Authorization needed");
    }
  }
  $("#wa-state").textContent =
    s.whatsapp.state.replaceAll("-", " ") +
    (s.whatsapp.warning ? " — " + s.whatsapp.warning : "");
  $("#qr").hidden = !s.whatsapp.qr;
  if (s.whatsapp.qr) $("#qr").src = s.whatsapp.qr;
  $("#pending").textContent = s.pendingRequests
    ? s.pendingRequests +
      " unfinished Gemini request snapshot(s) retained for recovery."
    : "No unfinished Gemini request snapshots.";
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    render(await api("/api/state"));
  } catch (e) {
    notice(
      e.message === "OPEN_FROM_START_JUNE"
        ? "Open this panel using the desktop Start June button."
        : e.message.replaceAll("_", " "),
    );
  } finally {
    refreshing = false;
  }
}
action($("#collect"), async () => {
  notice("Checking connected mailboxes…");
  await api("/v1/jobs/collect", {});
  notice("Mailbox check complete.");
});
action($("#process"), async () => {
  notice("Local Qwen is processing queued messages…");
  await api("/v1/jobs/process", {});
  notice("Processing pass complete. Check the review queue.");
});
action($("#discover"), async () => {
  notice("Research is running; the brief will appear here when ready.");
  await api("/v1/jobs/research", {});
  notice("Research pass complete.");
});
action($("#connect-wa"), async () => {
  await api("/api/whatsapp", {});
  notice("Scan the QR with WhatsApp → Linked devices.");
});
$("#command").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/command", { command: $("#local-command").value });
    $("#local-command").value = "";
    notice("List updated locally. No AI request was used.");
    await refresh();
  } catch (e) {
    notice(e.message.replaceAll("_", " "));
  }
});
$("#task").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/research", {
      title: $("#task-title").value,
      brief: $("#task-brief").value,
    });
    $("#task").reset();
    notice("Research queued. June will prepare a source-linked resource pack.");
    await refresh();
  } catch (e) {
    notice(e.message);
  }
});
try {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname);
    await api("/api/login", { token });
  }
  await refresh();
  if (latest)
    notice(
      "June is ready. Connect your accounts once, then collection runs while June is on.",
    );
} catch {
  notice("Use Start June on your desktop to open your private control panel.");
}
setInterval(refresh, 7000);

$("#talk").addEventListener("click", async (event) => {
  event.preventDefault();
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const result = await api("/api/talk-url");
    if (tab) tab.location.replace(result.url);
    else location.href = result.url;
  } catch {
    tab?.close();
    notice("June conversation is unavailable. Check Gateway status.");
  }
});

for (const link of document.querySelectorAll("[data-viewer]"))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    window.open(
      link.getAttribute("href"),
      "June" + link.dataset.viewer,
      "width=1320,height=900",
    );
  });
