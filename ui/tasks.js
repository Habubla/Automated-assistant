const $ = (s) => document.querySelector(s),
  n = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
let selected = new URLSearchParams(location.search).get("id"),
  current = [],
  refreshing = false,
  opps = false;
const notice = (s) => ($("#notice").textContent = s);
async function api(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-june-action": "1" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok || d.ok === false) throw Error(d.error || "REQUEST_FAILED");
  return d;
}
const date = (s) =>
  s
    ? new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(s)) + " IST"
    : "Needs a due date";
function links(e, text) {
  let last = 0;
  for (const m of text.matchAll(/https:\/\/[^\s<>"\])}]+/g)) {
    e.append(document.createTextNode(text.slice(last, m.index)));
    const a = n("a", m[0]);
    a.href = m[0];
    a.target = "_blank";
    a.rel = "noreferrer";
    e.append(a);
    last = m.index + m[0].length;
  }
  e.append(document.createTextNode(text.slice(last)));
}
function action(label, fn) {
  const b = n("button", label);
  b.onclick = async () => {
    b.disabled = true;
    try {
      await fn();
      await refresh();
    } catch (e) {
      notice(e.message.replaceAll("_", " "));
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
async function choose(id) {
  selected = id;
  const d = await api("/api/tasks/item?id=" + encodeURIComponent(id)),
    t = d.task;
  const e = $("#detail");
  e.replaceChildren(
    n("h2", t.title),
    n("p", date(t.due_at)),
    n("p", t.timing_note),
  );
  const actions = n("div");
  actions.className = "actions";
  for (const [label, patch] of [
    ["Confirm task", { status: "confirmed" }],
    ["Complete", { status: "completed" }],
    ["Snooze 1 hour", { snoozeMinutes: 60 }],
    ["Dismiss", { status: "dismissed" }],
  ])
    actions.append(
      action(label, () => api("/api/tasks/update", { id, ...patch })),
    );
  actions.append(
    action(t.reminder_enabled ? "Mute reminders" : "Enable reminders", () =>
      api("/api/tasks/update", { id, reminders: !t.reminder_enabled }),
    ),
  );
  e.append(actions);
  const edit = n("form"),
    label = n("label", "Change due date / time (IST)"),
    input = n("input");
  input.type = "datetime-local";
  input.required = true;
  input.setAttribute("aria-label", "New due date and time in IST");
  if (t.due_at)
    input.value = new Date(Date.parse(t.due_at) + 19800000)
      .toISOString()
      .slice(0, 16);
  label.append(input);
  edit.append(label, n("button", "Save deadline"));
  edit.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/tasks/update", { id, dueAt: input.value + ":00+05:30" });
      await refresh();
      notice("Deadline updated.");
    } catch (err) {
      notice(err.message);
    }
  };
  e.append(edit);
  const brief = n("div");
  brief.className = "brief";
  links(brief, t.brief);
  e.append(n("h3", "Prepared brief"), brief);
  if (t.thread_id && t.source === "whatsapp") {
    const a = n("a", "Open WhatsApp messages ↗");
    a.href = "/messages?thread=" + encodeURIComponent(t.thread_id);
    e.append(a);
  }
  for (const b of $("#task-list").children)
    b.classList.toggle("active", b.dataset.id === id);
}
async function loadTasks() {
  const data = await api(
    "/api/tasks?" +
      new URLSearchParams({
        q: $("#search").value,
        status: $("#show-all").checked ? "all" : "open",
      }),
  );
  current = data.tasks;
  const list = $("#task-list");
  list.replaceChildren();
  for (const t of current) {
    const b = n("button");
    b.className = "task";
    b.dataset.id = t.id;
    b.append(
      n("strong", t.title),
      n("small", date(t.due_at)),
      n(
        "small",
        [t.source || "Personal task", t.chat_name || t.sender_name]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const tag = n("span", t.status);
    tag.className = "tag";
    b.append(tag);
    if (t.due_at && Date.parse(t.due_at) < Date.now()) {
      const overdue = n("span", "Overdue");
      overdue.className = "tag overdue";
      b.append(overdue);
    }
    b.onclick = () => choose(t.id).catch((e) => notice(e.message));
    list.append(b);
  }
  if (!current.length)
    list.append(
      n(
        "p",
        "No tasks in this view. New deadlines will appear automatically; you can also add a reminder.",
      ),
    );
  const notif = $("#notifications");
  notif.replaceChildren();
  for (const r of data.notifications.slice(0, 5)) {
    const row = n("div");
    row.append(
      n("span", r.title + " · " + date(r.due_at)),
      action("Open", () => choose(r.task_id)),
      action("Dismiss alert", () => api("/api/tasks/reminder", { id: r.id })),
    );
    notif.append(row);
  }
  if (!selected && current.length) selected = current[0].id;
  if (selected) await choose(selected);
}
async function loadOpportunities() {
  const data = await api("/api/opportunities");
  $("#connection").textContent = data.connection.explanation;
  $("#scan-status").textContent =
    "Public scans: " +
    data.connection.schedule +
    " · " +
    (data.connection.status || "scheduled") +
    (data.connection.lastSuccess
      ? " · Last ready: " + date(data.connection.lastSuccess)
      : "") +
    (data.connection.error
      ? " · " + data.connection.error.replaceAll("_", " ")
      : "");
  $("#pool-status").textContent =
    "Gemini pool: " +
    data.pool.configured +
    " keys loaded from your private file. Keys in the same Google project share a quota.";
  const list = $("#opportunities");
  list.replaceChildren();
  for (const item of data.items) {
    const card = n("div"),
      details = n("details"),
      brief = n("div");
    brief.className = "brief";
    links(brief, item.brief);
    details.append(
      n("summary", item.title),
      n("p", item.source + " · " + date(item.created_at)),
      brief,
    );
    if (item.url) {
      const a = n("a", "Open original opportunity ↗");
      a.href = item.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      details.append(a);
    }
    card.append(details);
    list.append(card);
  }
  if (!data.items.length)
    list.append(
      n(
        "p",
        "Your first scan is preparing. LinkedIn email alerts will appear here when they arrive in a connected mailbox.",
      ),
    );
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (opps) await loadOpportunities();
    else await loadTasks();
  } catch (e) {
    notice(
      e.message === "OPEN_FROM_START_JUNE"
        ? "Open June Tasks from your desktop button to reconnect."
        : e.message.replaceAll("_", " "),
    );
  } finally {
    refreshing = false;
  }
}
for (const [id, isOpps] of [
  ["#tab-tasks", false],
  ["#tab-opps", true],
])
  $(id).onclick = () => {
    opps = isOpps;
    $("#task-section").hidden = opps;
    $("#opportunity-section").hidden = !opps;
    $("#tab-tasks").classList.toggle("selected", !opps);
    $("#tab-opps").classList.toggle("selected", opps);
    refresh();
  };
$("#refresh").onclick = refresh;
$("#search").oninput = refresh;
$("#show-all").onchange = refresh;
$("#add-toggle").onclick = () =>
  ($("#add-form").hidden = !$("#add-form").hidden);
$("#add-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const result = await api("/api/tasks/add", {
      title: $("#new-title").value,
      dueAt: $("#new-due").value + ":00+05:30",
      notes: $("#new-notes").value,
    });
    selected = result.task.id;
    e.target.reset();
    e.target.hidden = true;
    await refresh();
    notice("Task saved. Reminders are enabled.");
  } catch (err) {
    notice(err.message);
  }
};
$("#scan").onclick = async () => {
  await api("/api/opportunities/scan", {});
  notice(
    "Public opportunity scan queued. Results will appear here when ready.",
  );
  await refresh();
};
try {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname + location.search);
    await api("/api/login", { token });
  }
  await refresh();
  notice(
    "Prepared briefs stay on this computer. Reminder pop-ups appear while June’s task widget is running.",
  );
} catch (e) {
  notice(e.message);
}
setInterval(() => {
  if (!document.querySelector("input:focus,textarea:focus")) refresh();
}, 15000);
