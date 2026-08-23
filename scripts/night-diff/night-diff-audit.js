// COMMIT 2 pre-flight: every duty row in the range carrying night differential,
// classified, with the post-fix value PREDICTED before the fix exists.
//
// The prediction uses phTime.nightMinutesIn — the SAME function the engine
// calls — so this is not a second implementation of the night window that could
// quietly disagree with it. What it decides independently is WHICH interval to
// measure, which is exactly what the fix changes.
//
//   READ-ONLY, enforced not asserted: db.js is never loaded (its require.cache
//   slot is pre-filled), and every statement runs inside its own BEGIN READ
//   ONLY. Safe against production. Session-level read-only is deliberately NOT
//   used — these are Neon POOLER endpoints and a session GUC leaks to whoever
//   is handed that backend next.
//
// usage: node night-diff-audit.js 2026-08-16 2026-08-18 --db "<conn string>"
const path = require("path");
// Resolved from this file's own location, never hardcoded: an absolute path
// to one developer's checkout is useless to everyone else.
const ROOT = require("path").resolve(__dirname, "..", "..");
require("dotenv").config({ path: ROOT + "/.env" });

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
if (dbFlag !== -1) { process.env.DATABASE_URL = args[dbFlag + 1]; args.splice(dbFlag, 2); }
// --json emits the SAME rows the table prints, for the verifier. Parsing the
// human table back was brittle and silently matched nothing.
const JSON_OUT = args.includes("--json");
if (JSON_OUT) args.splice(args.indexOf("--json"), 1);
const FROM = args[0], TO = args[1];
if (!FROM || !TO) {
  console.error("usage: node night-diff-audit.js <from> <to> [--db <conn>]");
  process.exit(2);
}

const { Pool } = require("pg");
const realPool = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = {
  async query(...a) {
    const c = await realPool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      const r = await c.query(...a);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw e;
    } finally { c.release(); }
  },
  end: () => realPool.end(),
};
const dbPath = require.resolve(ROOT + "/src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, path: path.dirname(dbPath),
  loaded: true, children: [], paths: [], exports: { pool, ready: Promise.resolve() },
};

const { computeReport } = require(ROOT + "/src/routes/attendance-reports");
const { nightMinutesIn, dateAtTime } = require(ROOT + "/src/lib/phTime");

const HR = 3600000;
const clock = (ms) => (ms == null ? "—" : new Date(ms + 8 * HR).toISOString().slice(11, 16));
const stamp = (ms) => (ms == null ? "—" : new Date(ms + 8 * HR).toISOString().slice(5, 16).replace("T", " "));

(async () => {
  const cfg = {};
  for (const r of (await pool.query("SELECT key, config FROM payroll_statutory_config")).rows) {
    cfg[r.key] = r.config;
  }
  const payRules = cfg.pay_rules || {};
  const premium = cfg.premium_rules || {};
  const nightRules = {
    nightStartHour: premium.nightStartHour ?? 22,
    nightEndHour: premium.nightEndHour ?? 6,
  };
  console.log(`night window ${nightRules.nightStartHour}:00 -> 0${nightRules.nightEndHour}:00`
    + `   nightDiffPercent ${premium.nightDiffPercent}   otThreshold ${payRules.otThresholdMinutes}\n`);

  // What the engine sees, through the same lookback the payroll route uses.
  const { rows } = await computeReport({
    from: FROM, to: TO, site: null, guard: null,
    grace: payRules.graceMinutes ?? 15, otThreshold: payRules.otThresholdMinutes ?? 30,
  });

  // What production currently HOLDS, so drift between stored and recomputed is
  // visible rather than assumed away.
  const stored = new Map();
  const sres = await pool.query(
    `SELECT l."employeeName", to_char(d."dutyDate",'YYYY-MM-DD') AS dd,
            d."nightMinutes", d."nightOtMinutes", d."nightDiffPay"
       FROM payroll_line_days d
       JOIN payroll_lines l ON l.id = d."lineId"
       JOIN payroll_periods p ON p.id = l."periodId"
      WHERE p."periodStart" = $1::date AND p."periodEnd" = $2::date`, [FROM, TO]);
  for (const r of sres.rows) stored.set(`${r.employeeName}|${r.dd}`, r);

  // The engine pays APPROVED excess OT (approvedOtByDate), not the minutes
  // attendance merely DETECTED. Using the detected figure here would predict
  // night diff on overtime nobody approved and therefore nobody is paid for.
  const approvedOt = new Map();
  const ores = await pool.query(
    `SELECT "employeeId", to_char("dutyDate",'YYYY-MM-DD') AS dd,
            sum(coalesce("approvedMinutes",0))::int AS mins
       FROM overtime_records
      WHERE status = 'Approved' AND "employeeId" IS NOT NULL
        AND "dutyDate" >= $1::date AND "dutyDate" <= $2::date
      GROUP BY 1,2`, [FROM, TO]);
  for (const r of ores.rows) approvedOt.set(`${r.employeeId}|${r.dd}`, Number(r.mins) || 0);

  const out = [];
  for (const r of rows) {
    if (r.dutyDate < FROM || r.dutyDate > TO) continue;   // lookback rows
    if (!r.timeIn || !r.timeOut) continue;                 // engine prices no night diff
    const inMs = Date.parse(r.timeIn), outMs = Date.parse(r.timeOut);
    if (!(outMs > inMs)) continue;

    const broken = Array.isArray(r.workedIntervals) && r.workedIntervals.length > 0;
    const schedStart = r.startTime ? dateAtTime(r.dutyDate, r.startTime) : null;
    const schedEnd = r.endTime ? dateAtTime(r.dutyDate, r.endTime, r.crossesMidnight ? 1 : 0) : null;

    // ---- CURRENT engine arithmetic, reproduced exactly -------------------
    const startRef = schedStart == null ? inMs : schedStart;
    const eight = startRef + 8 * HR;
    const regEnd = Math.min(outMs, eight);
    const otStart = Math.max(inMs, eight);
    const curReg = regEnd > inMs ? nightMinutesIn(inMs, regEnd, nightRules) : 0;
    const curOt = outMs > otStart ? nightMinutesIn(otStart, outMs, nightRules) : 0;
    const current = curReg + curOt;
    if (current <= 0) continue;

    // ---- PREDICTED under the paid-minutes rule ---------------------------
    // Paid = the scheduled duty window, plus approved excess OT worked past the
    // scheduled end — each intersected with what was actually worked.
    const excessMin = approvedOt.get(`${r.employeeId}|${r.dutyDate}`) || 0;
    const detectedMin = Number(r.overtimeMin) || 0;
    let predSched = 0, predOt = 0, note = "";
    const trims = [];
    if (broken) {
      note = "BROKEN shift - predicted from its worked stretches";
      for (const [a, b] of r.workedIntervals) {
        predSched += nightMinutesIn(Date.parse(a), Date.parse(b), nightRules);
      }
    } else if (schedStart == null || schedEnd == null) {
      note = "UNROSTERED - no scheduled window to clamp to";
      predSched = nightMinutesIn(inMs, outMs, nightRules);
    } else {
      const paidLo = Math.max(schedStart, inMs);
      const paidHi = Math.min(schedEnd, outMs);
      predSched = paidHi > paidLo ? nightMinutesIn(paidLo, paidHi, nightRules) : 0;
      const otLo = Math.max(schedEnd, inMs);
      const otHi = Math.min(outMs, schedEnd + excessMin * 60000);
      predOt = otHi > otLo ? nightMinutesIn(otLo, otHi, nightRules) : 0;

      // NAME the minutes being taken away, so "is this trim genuine?" can be
      // answered from the report instead of trusted. The current calc measures
      // night minutes across the WHOLE punch interval, so what the fix removes
      // is exactly the night portion of the two unpaid tails: before the
      // scheduled start, and after approved OT ends.
      const bLo = inMs, bHi = Math.min(schedStart, outMs);
      if (bHi > bLo) {
        const m = nightMinutesIn(bLo, bHi, nightRules);
        if (m > 0) trims.push({ what: "before scheduled start",
          span: `${clock(bLo)}-${clock(bHi)}`, mins: m });
      }
      const aLo = Math.max(inMs, Math.min(outMs, schedEnd + excessMin * 60000));
      if (outMs > aLo) {
        const m = nightMinutesIn(aLo, outMs, nightRules);
        if (m > 0) trims.push({
          what: excessMin > 0 ? "after approved OT ended" : "after scheduled end, no OT approved",
          span: `${clock(aLo)}-${clock(outMs)}`, mins: m });
      }
    }
    const predicted = predSched + predOt;

    // ---- classification --------------------------------------------------
    const schedTouchesNight = (schedStart != null && schedEnd != null)
      ? nightMinutesIn(schedStart, schedEnd, nightRules) > 0 : false;
    // The label has to line up with the STOP rule it will be read against, so a
    // row that is EXPECTED to move is never filed under "unchanged". A shift
    // scheduled across the night window can still carry unpaid minutes outside
    // that window (an early arrival before a 05:00 start), and trimming those
    // moves it — by design, not as a regression. That is (c*), kept apart from
    // the plain (c) rows which must not move at all.
    let kind;
    if (broken) kind = "(d) BROKEN";
    else if (schedStart == null) kind = "(d) UNROSTERED";
    else if (schedTouchesNight) {
      kind = predicted === current ? "(c) night/straight" : "(c*) night/straight TRIMMED";
    } else if (predOt > 0) kind = "(b) day + OT into window";
    else kind = "(a) day, unpaid minutes";

    const st = stored.get(`${r.guardName}|${r.dutyDate}`);
    out.push({
      case: kind, guard: r.guardName, date: r.dutyDate,
      shift: r.shiftName || "—",
      sched: schedStart != null ? `${r.startTime}-${r.endTime}${r.crossesMidnight ? "+1" : ""}` : "—",
      punchIn: clock(inMs), punchOut: stamp(outMs),
      builtin: Number(r.builtinOtMin) || 0, excess: excessMin, detected: detectedMin,
      otSpan: (schedEnd != null && excessMin > 0)
        ? `${clock(schedEnd)}-${clock(schedEnd + excessMin * 60000)}` : "—",
      curReg, curOt, current,
      storedNight: st ? Number(st.nightMinutes) + Number(st.nightOtMinutes) : null,
      storedPay: st ? st.nightDiffPay : null,
      predicted, delta: predicted - current, note, trims,
      trimMins: trims.reduce((n, t) => n + t.mins, 0),
    });
  }

  out.sort((a, b) => a.case.localeCompare(b.case)
    || a.guard.localeCompare(b.guard) || a.date.localeCompare(b.date));

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); await pool.end(); return; }
  console.log(`${out.length} duty row(s) carrying night differential in ${FROM} .. ${TO}\n`);
  const H = ["CASE", "GUARD", "DATE", "SHIFT", "SCHEDULED", "IN", "OUT",
    "B.OT", "X.OT appr", "(detect)", "OT SPAN", "NIGHT now", "stored", "PRED", "delta"];
  const body = out.map((o) => [o.case, o.guard, o.date, o.shift, o.sched, o.punchIn, o.punchOut,
    String(o.builtin), String(o.excess), String(o.detected), o.otSpan,
    `${o.current} (${o.curReg}+${o.curOt})`,
    o.storedNight == null ? "—" : String(o.storedNight), String(o.predicted),
    o.delta > 0 ? `+${o.delta}` : String(o.delta)]);
  const w = H.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (c) => c.map((v, i) => v.padEnd(w[i])).join("  ");
  console.log(line(H));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(line(r));

  const byCase = {};
  for (const o of out) {
    const b = byCase[o.case] || (byCase[o.case] = { n: 0, cur: 0, pred: 0 });
    b.n++; b.cur += o.current; b.pred += o.predicted;
  }
  console.log("\nby case:");
  for (const [k, v] of Object.entries(byCase)) {
    console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(3)} row(s)   `
      + `${String(v.cur).padStart(5)} night-min now  ->  ${String(v.pred).padStart(5)} predicted`);
  }

  const current0 = (o) => -o.delta;
  const moversC = out.filter((o) => o.case.startsWith("(c*)"));
  if (moversC.length) {
    console.log("\n(c*) rows move BY DESIGN — each one loses only unpaid minutes"
      + " outside its scheduled window. Inspect before accepting:");
    for (const o of moversC) {
      console.log(`  ${o.guard}  ${o.date}  scheduled ${o.sched}  punched ${o.punchIn} -> ${o.punchOut}`);
      console.log(`      night diff ${o.current} -> ${o.predicted} min  (${o.delta})`);
      for (const t of o.trims) {
        console.log(`      removed ${String(t.mins).padStart(3)} min  ${t.span}  ${t.what}`);
      }
      const explained = o.trimMins === current0(o) ? "" : "   <-- UNEXPLAINED, investigate";
      console.log(`      accounted for: ${o.trimMins} of ${-o.delta} min${explained}`);
    }
  }
  const plainC = out.filter((o) => o.case.startsWith("(c) ") && o.delta !== 0);
  console.log(`\nplain (c) rows that MOVE: ${plainC.length}`
    + (plainC.length ? "   <-- STOP, the night/straight path is wrong" : "   (must be 0)"));

  const drift = out.filter((o) => o.storedNight != null && o.storedNight !== o.current);
  console.log(`\nstored-vs-recomputed drift: ${drift.length} row(s)`
    + (drift.length ? "   <-- investigate before trusting the prediction" : ""));
  for (const d of drift) {
    console.log(`  ${d.guard} ${d.date}: stored ${d.storedNight} vs recomputed ${d.current}`);
  }
  const notes = out.filter((o) => o.note);
  if (notes.length) {
    console.log("\nnotes:");
    for (const o of notes) console.log(`  ${o.guard} ${o.date}: ${o.note}`);
  }
  await pool.end();
})().catch(async (e) => {
  console.error("AUDIT ERROR", e);
  try { await pool.end(); } catch { /* */ }
  process.exit(1);
});
