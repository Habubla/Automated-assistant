import { createHash } from "node:crypto";
import { redactSensitiveText } from "../util.js";
const idFor = (s) =>
  "OPP-" + createHash("sha256").update(s).digest("hex").slice(0, 32);
export const scanSlot = (now = Date.now()) => {
  const local = new Date(now + 19800000),
    hour = local.getUTCHours();
  const date = local.toISOString().slice(0, 10);
  if (hour >= 18) return date + "-18";
  if (hour >= 9) return date + "-09";
  return new Date(now + 19800000 - 86400000).toISOString().slice(0, 10) + "-18";
};
export class Opportunities {
  constructor(store, pool, { research } = {}) {
    this.store = store;
    this.pool = pool;
    this.research = research;
    this.running = false;
    store.set("scheduledOpportunitiesEnabled", true);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS opportunities(id TEXT PRIMARY KEY,source TEXT NOT NULL,title TEXT NOT NULL,brief TEXT NOT NULL,url TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new');
      CREATE TABLE IF NOT EXISTS opportunity_mail_scanned(source_id TEXT PRIMARY KEY REFERENCES inbox(id));`);
  }
  collectAlerts() {
    const rows = this.store.db
      .prepare(
        "SELECT i.* FROM inbox i LEFT JOIN opportunity_mail_scanned s ON i.id=s.source_id WHERE i.source='email' AND s.source_id IS NULL",
      )
      .all();
    let added = 0;
    for (const row of rows) {
      const domain = row.sender.toLowerCase().split("@").at(-1);
      if (domain === "linkedin.com" || domain?.endsWith(".linkedin.com")) {
        const content = row.subject + "\n" + row.body;
        if (
          /job|internship|event|webinar|course|opportunit|competition|research|project|learning/i.test(
            content,
          )
        ) {
          const urls = (content.match(/https:\/\/[^\s<>"\])}]+/g) ?? []).filter(
            (s) => {
              try {
                const u = new URL(s);
                return (
                  !u.username &&
                  !u.password &&
                  (u.hostname === "linkedin.com" ||
                    u.hostname.endsWith(".linkedin.com"))
                );
              } catch {
                return false;
              }
            },
          );
          added += this.store.db
            .prepare(
              "INSERT OR IGNORE INTO opportunities(id,source,title,brief,url,created_at) VALUES(?,?,?,?,?,?)",
            )
            .run(
              idFor(row.id),
              "LinkedIn email alert",
              row.subject || "LinkedIn opportunity alert",
              row.body +
                "\n\nEmail alert only. Verify availability, eligibility, fees and dates on the original page.",
              urls[0] || "https://www.linkedin.com/jobs/",
              row.received_at,
            ).changes;
        }
      }
      this.store.db
        .prepare("INSERT OR IGNORE INTO opportunity_mail_scanned VALUES(?)")
        .run(row.id);
    }
    return added;
  }
  list() {
    return this.store.db
      .prepare("SELECT * FROM opportunities ORDER BY created_at DESC LIMIT 100")
      .all();
  }
  state() {
    return {
      connection: "Email alerts and public sources",
      accountFeedConnected: false,
      explanation:
        "The available LinkedIn connector cannot read your feed or events. June collects LinkedIn alerts arriving in connected mailboxes; enable email alerts in LinkedIn to receive them here.",
      schedule: "09:00 and 18:00 IST, with catch-up after startup",
      running: this.running,
      ...this.store.get("opportunityScan", {}),
    };
  }
  async scan({ force = false, now = Date.now() } = {}) {
    this.collectAlerts();
    const previous = this.store.get("opportunityScan", {}),
      slot = scanSlot(now);
    if (this.running) return { ok: true, status: "already-running" };
    if (
      !force &&
      (previous.completedSlot === slot || previous.nextAttempt > now)
    )
      return { ok: true, status: "scheduled" };
    this.running = true;
    this.store.set("opportunityScan", {
      ...previous,
      error: null,
      lastAttempt: new Date(now).toISOString(),
      status: "scanning",
    });
    try {
      const prompt =
        "Today is " +
        new Date(now + 19800000).toISOString().slice(0, 10) +
        " in India. Search current public web sources (including LinkedIn public event/job pages, Unstop, and organizer or university sites) for worthwhile opportunities for an absolute beginner Electrical/Electronics engineering student in India: free finance courses and reputable CV competitions, beginner core electronics research or buildable projects, and preferably remote internships. Cite an HTTPS source for every item. Distinguish open opportunities from evergreen project ideas. Include eligibility, cost/free status, deadline and timezone only when verified, and a practical next step. Flag unknown dates/fees clearly. Exclude expired opportunities and paid competitions. Do not invent verification or use private account data. Return a detailed brief grouped by category.";
      let prepared;
      if (this.research)
        try {
          prepared = await this.research(prompt, slot);
        } catch {
          /* Try the independently quota-controlled grounding route. */
        }
      if (!prepared) {
        const result = await this.pool.generate(
          {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: {
              maxOutputTokens: 4500,
              thinkingConfig: { thinkingLevel: "LOW" },
            },
          },
          { requestId: "public-scan-" + slot },
        );
        const candidate = result.candidates?.[0],
          grounding = candidate?.groundingMetadata;
        const sources = (grounding?.groundingChunks ?? [])
          .map((c) => c.web)
          .filter((w) => w?.uri?.startsWith("https://"));
        const content = (candidate?.content?.parts ?? [])
          .filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join("\n");
        if (
          !content ||
          !sources.length ||
          candidate.finishReason === "MAX_TOKENS"
        )
          throw Error("RESEARCH_UNVERIFIED");
        prepared = {
          content,
          sources,
          checksFailed: 0,
          route: "Google Search grounding",
        };
      }
      const { content, sources, checksFailed, route } = prepared;
      const brief =
        "RESEARCH LEADS\nA fetched page does not establish current availability or every fee/eligibility claim. Review the source checks below before applying.\n\n" +
        redactSensitiveText(content) +
        (checksFailed
          ? "\n\nSome source checks were unavailable. Review the verification notes and original pages before applying."
          : "") +
        "\n\nSEARCH SOURCES\n" +
        sources
          .map(
            (s) =>
              s.title +
              "\n" +
              s.uri +
              (s.verification ? "\n" + s.verification : ""),
          )
          .join("\n\n");
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO opportunities(id,source,title,brief,url,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          idFor(slot),
          "Scheduled public web scan",
          "Opportunity brief · " + slot.replace(/-(09|18)$/, " $1:00 IST"),
          brief,
          "",
          new Date(now).toISOString(),
        );
      this.pool.completePending?.("public-scan-" + slot);
      this.store.set("opportunityScan", {
        status: "ready",
        completedSlot: slot,
        lastSuccess: new Date().toISOString(),
        sources: sources.length,
        checksFailed,
        route,
        nextAttempt: 0,
      });
      return { ok: true, status: "ready", sources: sources.length };
    } catch (e) {
      const error = /^[A-Z_]+$/.test(e.message)
        ? e.message
        : "RESEARCH_UNAVAILABLE";
      this.store.set("opportunityScan", {
        ...previous,
        status: "retry-later",
        error,
        lastAttempt: new Date(now).toISOString(),
        nextAttempt: now + 3600000,
      });
      return { ok: false, status: "retry-later", error };
    } finally {
      this.running = false;
    }
  }
}
