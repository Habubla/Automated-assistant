import fs from "node:fs/promises";
import path from "node:path";
import { boundedResponse } from "../provider.js";

// Fixed public educational pages; no mailbox content or personal profile enters a request.
export const sources = [
  {
    title: "MIT 6.002 — Circuits and Electronics",
    url: "https://ocw.mit.edu/courses/6-002-circuits-and-electronics-spring-2007/",
    match: /Circuits and Electronics/i,
    note: "Archived undergraduate course with lectures, problems and labs. Free learning materials; no enrollment deadline or certificate claim. Start with circuit abstraction and resistive networks.",
  },
  {
    title: "Yale — Financial Markets",
    url: "https://oyc.yale.edu/economics/econ-252-08",
    match: /Financial Markets/i,
    note: "Archived Robert Shiller lectures for finance foundations. Use for learning, not current market data or a certificate. Start with risk and financial institutions.",
  },
  {
    title: "Arduino — Analog Read Serial",
    url: "https://docs.arduino.cc/built-in-examples/basics/AnalogReadSerial/",
    match: /AnalogReadSerial|Analog Read Serial/i,
    note: "Beginner analog-input tutorial. Project idea: build a low-voltage sensor logger, plot readings, document calibration and errors. Begin with an Arduino-compatible board, USB cable, potentiometer, breadboard and jumpers; hardware costs extra. Deliver circuit diagram, code, measurements and a short demonstration.",
  },
  {
    title: "Forage — job simulations",
    url: "https://www.theforage.com/",
    match: /job simulations/i,
    note: "Free, self-paced work simulations with completion certificates, including finance topics. These are learning experiences, not employment or paid internships. Choose an introductory simulation and describe it accurately on your CV.",
  },
];
export async function prepareStarterResources({
  store,
  researchRoot,
  fetchImpl = fetch,
}) {
  const day = new Date().toISOString().slice(0, 10);
  const id = "STARTER-EEE-FINANCE";
  if (store.get("starterChecked") === day) return;
  const checks = await Promise.all(
    sources.map(async (source) => {
      try {
        const response = await fetchImpl(source.url, {
          redirect: "error",
          signal: AbortSignal.timeout(12000),
          headers: { "user-agent": "June-Local-Resource-Checker/1.0" },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error("unavailable");
        }
        const page = await boundedResponse(response, 3000000);
        if (
          /captcha|verify you are human|unusual traffic/i.test(page) ||
          !source.match.test(page)
        )
          throw Error("unverified");
        return { ...source, checked: true };
      } catch {
        return { ...source, checked: false };
      }
    }),
  );
  const output =
    "Starter resources for Electrical/Electronics and finance\n\nChecked: " +
    new Date().toISOString() +
    "\nThis curated pack uses no Gemini requests. An available page is not proof of a current competition, job opening, or eligibility.\n\n" +
    checks
      .map(
        (source) =>
          source.title +
          "\n" +
          source.url +
          "\n" +
          (source.checked
            ? "Page reachable and subject matched today."
            : "Live check unavailable; verify the page before relying on it.") +
          "\n" +
          source.note,
      )
      .join("\n\n") +
    "\n\nBeginner research practice (suggested project, not a placement): reproduce an RC filter in a simulator, calculate the cutoff frequency, compare simulated and measured results, and explain deviations. Use MIT's circuit theory as the reference. Keep the first build at USB/battery voltage.\n\n" +
    "Opportunity discovery: use LinkedIn job alerts and Unstop alerts for remote beginner internships and free-entry finance/electronics competitions. Connected mailbox alerts can be collected locally. June's live search is a separate job; no open competition or internship is claimed by this starter pack.";
  store.research(
    "Electrical/Electronics + finance starter resources",
    "Curated public learning resources",
    id,
  );
  await fs.mkdir(researchRoot, { recursive: true });
  await fs.writeFile(
    path.join(researchRoot, id + ".md"),
    "# " + output + "\n",
    { mode: 0o600 },
  );
  store.db
    .prepare(
      "UPDATE research SET status='ready',result=?,error=NULL,updated_at=? WHERE id=?",
    )
    .run(output, new Date().toISOString(), id);
  store.set("starterChecked", day);
  return {
    id,
    checked: checks.filter((source) => source.checked).length,
    sources: checks.length,
  };
}
