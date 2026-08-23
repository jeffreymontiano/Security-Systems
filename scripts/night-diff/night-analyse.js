// Prices every production duty row through BOTH engines — the pre-fix one
// loaded straight out of git, and the shipped one — on identical inputs.
//
// Why both: the dump prints whole minutes, so a punch at 17:55:30 reads as
// 17:55. Comparing a prediction built from truncated inputs against a STORED
// value computed from exact instants would show phantom one-minute deltas.
// Running both engines over the same truncated inputs makes the truncation
// cancel, so the delta is purely the rule change. The leftover
// (stored - oldFromDump) is reported as `resid` — it measures the truncation,
// and a large one means the dump's punch pick disagrees with the engine's
// allocation and the row must not be trusted.
// Resolved from this file's own location, never hardcoded: an absolute path
// to one developer's checkout is useless to everyone else.
const ROOT = require("path").resolve(__dirname, "..", "..");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { nightMinutesIn, dateAtTime } = require(ROOT + "/src/lib/phTime");

function loadEngine(rev) {
  const src = execFileSync("git", ["show", `${rev}:src/lib/payrollEngine.js`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const f = path.join(__dirname, `_eng_${rev.replace(/[^a-z0-9]/gi, "")}.js`);
  fs.writeFileSync(f, src.replace(/require\("\.\/([^"]+)"\)/g,
    (_m, p) => `require(${JSON.stringify(ROOT + "/src/lib/" + p)})`));
  return require(f);
}
const OLD = loadEngine("HEAD~1");                      // 1bbf68d, the live rule
const NEW = require(ROOT + "/src/lib/payrollEngine");  // f77d7d8, the shipped fix

const HR = 3600000;
const NIGHT = { nightStartHour: 22, nightEndHour: 6 };
const clock = (ms) => new Date(ms + 8 * HR).toISOString().slice(11, 16);
const statutory = {
  pay_rules: { graceMinutes: 15, otMultiplier: 1.25, monthlyDivisor: 30,
    statutoryCutoff: "first", otThresholdMinutes: 30, withholdingTaxEnabled: false },
  premium_rules: { nightEndHour: 6, nightStartHour: 22, nightDiffPercent: 0.1,
    specialDayOt: 1.69, regularHolidayOt: 2.6, specialDayWorked: 1.3,
    regularHolidayWorked: 2, specialDayUnworkedPay: 0,
    requirePresenceDayBefore: true, regularHolidayUnworkedPay: 1 },
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((ln) => {
    const cells = []; let cur = "", q = false;
    for (const ch of ln) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] === "" ? null : cells[i]]));
  });
}

function phToMs(stamp, dutyDate) {
  if (!stamp) return null;
  const [md, hm] = stamp.trim().split(/\s+/);
  const [mo, d] = md.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  let year = Number(dutyDate.slice(0, 4));
  const dutyMo = Number(dutyDate.slice(5, 7));
  if (dutyMo === 12 && mo === 1) year += 1;
  if (dutyMo === 1 && mo === 12) year -= 1;
  return Date.UTC(year, mo - 1, d, h, mi) - 8 * HR;
}

function buildRow(r) {
  const tIn = phToMs(r.punch_in_ph, r.duty_date);
  const tOut = phToMs(r.punch_out_ph, r.duty_date);
  const straight = /straight/i.test(r.shift_kind || "");
  return {
    dutyDate: r.duty_date, guardName: r.guard, site: "",
    shiftName: r.shift_label || "",
    startTime: r.sched_start_time, endTime: r.sched_end_time,
    crossesMidnight: r.crosses_midnight === "t" || r.crosses_midnight === "true",
    startTime2: r.broken_start2, endTime2: r.broken_end2, crossesMidnight2: false,
    shiftKind: r.shift_kind || "", status: "Present", isRestDay: false,
    shiftUnits: straight ? 2 : 1,
    timeIn: new Date(tIn).toISOString(), timeOut: new Date(tOut).toISOString(),
    lateMin: 0, undertimeMin: 0,
    overtimeMin: Number(r.approved_ot_min) || 0,
    builtinOtMin: Number(r.ot_min_now) || 0,   // does not enter the night maths
    flags: [], _tIn: tIn, _tOut: tOut,
  };
}

function price(engine, row, r) {
  const excess = Number(r.approved_ot_min) || 0;
  return engine.computeEmployeeLine({
    employee: { id: 1, fullName: r.guard, payType: "Daily",
      dailyRate: Number(r.daily_rate) || 0, monthlyRate: 0 },
    attendanceRows: [row],
    approvedOtByDate: new Map(excess ? [[r.duty_date, excess]] : []),
    leaveRecords: [], isGuard: true, components: [], statutory,
    isFirstCutoff: false, periodStart: r.duty_date, periodEnd: r.duty_date,
    holidays: [], openingArrears: 0,
  });
}

// Name the minutes removed, so a delta is never just a number.
function trimsFor(row, r) {
  const out = [];
  if (!row.startTime || !row.endTime || row.startTime2) return out;
  const schedStart = dateAtTime(r.duty_date, row.startTime);
  const schedEnd = dateAtTime(r.duty_date, row.endTime, row.crossesMidnight ? 1 : 0);
  if (!(schedEnd > schedStart)) return out;
  const excess = Number(r.approved_ot_min) || 0;
  const bHi = Math.min(schedStart, row._tOut);
  if (bHi > row._tIn) {
    const m = nightMinutesIn(row._tIn, bHi, NIGHT);
    if (m > 0) out.push({ mins: m, span: `${clock(row._tIn)}-${clock(bHi)}`,
      what: "before scheduled start (early arrival, unpaid)" });
  }
  const aLo = Math.max(row._tIn, Math.min(row._tOut, schedEnd + excess * 60000));
  if (row._tOut > aLo) {
    const m = nightMinutesIn(aLo, row._tOut, NIGHT);
    if (m > 0) out.push({ mins: m, span: `${clock(aLo)}-${clock(row._tOut)}`,
      what: excess > 0 ? "after approved OT ended (unpaid)"
        : "after scheduled end, no OT approved (unpaid lingering)" });
  }
  return out;
}

const rows = parseCsv(fs.readFileSync(process.argv[2] || path.join(__dirname, "rows.csv"), "utf8"));
const res = [];
for (const r of rows) {
  const row = buildRow(r);
  const oldMin = Number(price(OLD, row, r).nightDiffMinutes);
  const newMin = Number(price(NEW, row, r).nightDiffMinutes);
  const storedMin = Number(r.night_min_now);
  const storedPay = Number(r.night_pay_now);
  const delta = newMin - oldMin;                 // the rule change, truncation cancelled
  const resid = storedMin - oldMin;              // truncation / pairing residual
  // What the recompute will actually store.
  //
  //  - delta == 0: the rule changes nothing for this row, so the stored value
  //    stands EXACTLY as it is. This is the case for a night guard who left
  //    early: the old rule already measured only to the punch-out, and so does
  //    the new one.
  //  - delta != 0: the row is trimmed back to a SCHEDULE-bounded edge (the
  //    scheduled start, or the end of approved OT), and a scheduled edge has no
  //    seconds component — so the new figure is exact and independent of the
  //    dump's minute truncation. Adding delta to the stored value instead would
  //    carry that truncation into the answer, and on a row clamped at zero it
  //    produces a NEGATIVE prediction, which is how this was caught.
  const predMin = delta === 0 ? storedMin : newMin;
  const hourly = (Number(r.daily_rate) || 0) / 8;
  const predPay = Math.round((predMin / 60) * hourly * 0.1 * 100) / 100;
  const trims = trimsFor(row, r);
  let scheduleBounded = null;
  if (row.startTime && row.endTime && !row.startTime2) {
    const ss = dateAtTime(r.duty_date, row.startTime);
    const se = dateAtTime(r.duty_date, row.endTime, row.crossesMidnight ? 1 : 0);
    if (se > ss) {
      const paidEnd = se + (Number(r.approved_ot_min) || 0) * 60000;
      scheduleBounded = Math.max(ss, row._tIn) === ss && Math.min(paidEnd, row._tOut) === paidEnd;
    }
  }
  const trimMins = trims.reduce((n, t) => n + t.mins, 0);
  const isNight = /night|straight/i.test(r.shift_kind || "");
  res.push({ r, storedMin, storedPay, oldMin, newMin, delta, resid, predMin, predPay,
    payDelta: Math.round((predPay - storedPay) * 100) / 100,
    trims, trimMins, isNight, scheduleBounded, explained: trimMins === -delta });
}

const W = [26, 12, 10, 8, 9, 7, 8, 8, 9, 7];
const H = ["GUARD", "DATE", "KIND", "IN", "OUT", "NOW", "PRED", "d MIN", "d PHP", "resid"];
console.log(H.map((h, i) => h.padEnd(W[i])).join(""));
console.log("-".repeat(W.reduce((a, b) => a + b, 0)));
for (const o of res) {
  console.log([
    o.r.guard, o.r.duty_date, o.r.shift_kind,
    o.r.punch_in_ph.slice(-5), o.r.punch_out_ph.slice(-5),
    String(o.storedMin), String(o.predMin),
    o.delta === 0 ? "-" : String(o.delta),
    o.payDelta === 0 ? "-" : o.payDelta.toFixed(2),
    o.resid === 0 ? "0" : String(o.resid),
  ].map((v, i) => String(v).padEnd(W[i])).join(""));
}

console.log("\n=== ROWS THAT MOVE ===");
const movers = res.filter((o) => o.delta !== 0);
for (const o of movers) {
  console.log(`\n  ${o.r.guard}  ${o.r.duty_date}  [${o.r.shift_kind}]`
    + (o.isNight ? "   <-- NIGHT/STRAIGHT-DUTY" : ""));
  console.log(`      scheduled ${o.r.sched_start_ph} -> ${o.r.sched_end_ph}`
    + `   punched ${o.r.punch_in_ph} -> ${o.r.punch_out_ph}   approved OT ${o.r.approved_ot_min}m`);
  console.log(`      night diff ${o.storedMin} -> ${o.predMin} min    PHP ${o.storedPay.toFixed(2)} -> ${o.predPay.toFixed(2)}   (${o.payDelta.toFixed(2)})`);
  for (const t of o.trims) console.log(`      removed ${String(t.mins).padStart(3)} min  ${t.span}  ${t.what}`);
  console.log(`      accounted for: ${o.trimMins} of ${-o.delta} min`
    + (o.explained ? "" : "   <-- UNEXPLAINED"));
}

const nightMovers = movers.filter((o) => o.isNight);
const unexplained = movers.filter((o) => !o.explained);
const bigResid = res.filter((o) => Math.abs(o.resid) > 1);
const totalMin = res.reduce((n, o) => n + (o.storedMin - o.predMin), 0);
const totalPhp = Math.round(res.reduce((n, o) => n + (o.storedPay - o.predPay), 0) * 100) / 100;

console.log("\n=== VERDICT ===");
console.log(`  rows analysed                 ${res.length}`);
console.log(`  rows moving                   ${movers.length}`);
console.log(`  night/straight-duty moving    ${nightMovers.length}`
  + (nightMovers.length ? "   <-- inspect each" : "   (0)"));
console.log(`  unexplained movements         ${unexplained.length}`
  + (unexplained.length ? "   <-- STOP" : "   (must be 0)"));
const shaky = movers.filter((o) => o.scheduleBounded !== true);
console.log(`  movers NOT schedule-bounded   ${shaky.length}`
  + (shaky.length ? "   <-- prediction only good to +/-1 min" : "   (0, so every prediction is exact)"));
for (const o of shaky) console.log(`      ${o.r.guard} ${o.r.duty_date}`);
console.log(`  truncation residual > 1 min   ${bigResid.length}`
  + (bigResid.length ? "   <-- dump pick may differ from engine allocation" : "   (0)"));
for (const o of bigResid) {
  console.log(`      ${o.r.guard} ${o.r.duty_date}: stored ${o.storedMin} vs old-rule-from-dump ${o.oldMin} (resid ${o.resid})`);
}
console.log(`\n  total night minutes removed   ${totalMin}`);
console.log(`  TOTAL PHP REMOVED             ${totalPhp.toFixed(2)}`);
console.log("     ^ gross and net must each fall by exactly this after the production recompute");

for (const f of fs.readdirSync(__dirname)) {
  if (f.startsWith("_eng_")) fs.unlinkSync(path.join(__dirname, f));
}
