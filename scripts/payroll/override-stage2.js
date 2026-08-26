// STAGE (ii): stale-override reconciliation and the Approve refusal.
//
// The worked example is the incident that motivated the feature: a PhilHealth
// rate typo made the engine assess PHP 2.14, someone overrode it, and the rate
// was then repaired to produce PHP 427.50. The override must NOT silently ride
// the corrected base — it has to be flagged and it has to block Approve until a
// human looks at it.
//
// Drives the real routes against a real database. Self-cleaning.
const ROOT = require("path").resolve(__dirname, "..", "..");
require(ROOT + "/node_modules/dotenv").config({ path: ROOT + "/.env" });
const jwt = require(ROOT + "/node_modules/jsonwebtoken");
const { Pool } = require(ROOT + "/node_modules/pg");

// ---------------------------------------------------------------------------
// PRODUCTION GUARD -- refuse before anything is touched.
//
// This suite deliberately sets philhealth.ratePercent to 0.025 to reproduce the
// incident, and creates and deletes payroll rows. Against production that would
// under-withhold PhilHealth on every subsequent compute -- the exact defect it
// exists to test. There is NO override flag: a switch that lets someone force
// this against production defeats the point of having the check.
//
// Matching is by SUBSTRING on the Neon endpoint id, not by exact hostname:
//   ep-sweet-bread-aoiz7aup-pooler.c-2.ap-southeast-1.aws.neon.tech   (pooled)
//   ep-sweet-bread-aoiz7aup.c-2.ap-southeast-1.aws.neon.tech          (direct)
// The endpoint id is the stable part; the -pooler infix and the regional suffix
// are not. Containment catches both forms and survives a region or suffix
// change, and it fails in the SAFE direction: a false match refuses a run that
// would have been fine, a false miss would let this loose on production.
const PRODUCTION_ENDPOINTS = ["ep-sweet-bread-aoiz7aup"];

function assertNotProduction(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    // Cannot prove it is safe, so refuse. Failing OPEN here would mean a
    // malformed or missing DATABASE_URL bypasses the only guard there is.
    console.error("\nREFUSING TO RUN: DATABASE_URL is missing or unparseable, so this "
      + "script cannot prove it is not pointed at production.\n");
    process.exit(2);
  }
  const hit = PRODUCTION_ENDPOINTS.find((ep) => host.includes(ep));
  if (hit) {
    console.error("\nREFUSING TO RUN AGAINST PRODUCTION.");
    console.error(`  DATABASE_URL host : ${host}`);
    console.error(`  matched endpoint  : ${hit}`);
    console.error("  This suite sets philhealth.ratePercent to 0.025 and writes payroll");
    console.error("  rows. Point DATABASE_URL at a dev branch and run it again.\n");
    process.exit(2);
  }
  console.log(`target database: ${host}\n  (not production -- checked against ${PRODUCTION_ENDPOINTS.join(", ")})\n`);
}
assertNotProduction(process.env.DATABASE_URL);

// Piping this script into `head` (or any reader that closes early) makes the
// next console.log throw EPIPE, which kills the process mid-run and leaves the
// philhealth rate sitting at 0.025 -- the exact fault the suite reproduces.
// That happened once during development. Swallowing the write error keeps the
// run alive to its own restore path.
process.stdout.on("error", (e) => { if (e && e.code === "EPIPE") return; throw e; });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE = "http://localhost:3000/api";
const SITE = "ZZOV Post";
const FROM = "2026-10-16", TO = "2026-10-31";
const GUARD = "ZZOV Override Guard", EMPNO = "ZOV-0001", RATE = 570;
const ph = (d, t) => new Date(`${d}T${t}:00+08:00`).toISOString();
let token = "", empId = null, periodId = null, phBackup = null;

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`
    + (ok ? "" : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`));
};
const api = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function cleanup() {
  await pool.query(`DELETE FROM payroll_line_overrides WHERE "employeeNo" LIKE 'ZOV-%'`);
  await pool.query(`DELETE FROM payroll_line_days WHERE "lineId" IN (SELECT id FROM payroll_lines WHERE "employeeNo" LIKE 'ZOV-%')`);
  await pool.query(`DELETE FROM payroll_lines WHERE "employeeNo" LIKE 'ZOV-%'`);
  await pool.query(`DELETE FROM payroll_periods WHERE "periodStart" = $1::date AND "periodEnd" = $2::date`, [FROM, TO]);
  await pool.query(`DELETE FROM attendance_records WHERE site = $1`, [SITE]);
  await pool.query(`DELETE FROM shift_assignments WHERE site = $1`, [SITE]);
  await pool.query(`DELETE FROM employees WHERE "employeeNo" LIKE 'ZOV-%'`);
  await pool.query(`DELETE FROM sites WHERE name = $1`, [SITE]);
  await pool.query(`DELETE FROM audit_log WHERE action LIKE 'payroll_override%' AND detail LIKE '%ZZOV%'`);
}

// The rate restore is SEPARATE from cleanup() and idempotent.
//
// Separate because cleanup() also runs at the START, before the suite has
// touched anything -- folding the restore in there would burn the guard flag on
// a no-op and leave the real restore skipped. Idempotent because the normal
// path, the error path and the signal handler can all reach it, and a Ctrl-C
// landing mid-cleanup must not run it twice or throw on a closing pool.
let rateRestored = false;
async function restoreRate() {
  if (rateRestored || !phBackup) return;
  rateRestored = true;
  try {
    await pool.query(`UPDATE payroll_statutory_config SET config = $1::jsonb WHERE key = 'philhealth'`,
      [JSON.stringify(phBackup)]);
  } catch (e) {
    // Say so loudly rather than exit quietly: an unrestored 0.025 is the very
    // fault this suite reproduces, and it would sit silently in the config.
    console.error(`\nFAILED TO RESTORE philhealth config: ${e.message}`);
    console.error(`Restore it by hand: ${JSON.stringify(phBackup)}\n`);
  }
}
const setRate = (rp) => pool.query(
  `UPDATE payroll_statutory_config SET config = config || jsonb_build_object('ratePercent', $1::numeric)
    WHERE key = 'philhealth'`, [rp]);
const compute = () => api(`/payroll/periods/${periodId}/compute`, { method: "POST", body: "{}" });
const storedPh = async () => Number((await pool.query(
  `SELECT "philhealthEe" FROM payroll_lines WHERE "periodId" = $1 AND "employeeNo" = $2`,
  [periodId, EMPNO])).rows[0].philhealthEe);
const ovRow = async () => (await pool.query(
  `SELECT * FROM payroll_line_overrides WHERE "employeeNo" = $1`, [EMPNO])).rows[0];

(async () => {
  phBackup = (await pool.query(`SELECT config FROM payroll_statutory_config WHERE key='philhealth'`)).rows[0].config;

  // Registered HERE, not at module scope: phBackup is now populated, so the
  // handler can never fire with an empty backup and "restore" nothing. Guarded
  // against re-entry so a second Ctrl-C during the restore does not stack.
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${sig} -- restoring the philhealth config before exit...`);
      await restoreRate();
      try { await cleanup(); } catch { /* best effort */ }
      try { await pool.end(); } catch { /* already closing */ }
      console.log("restored. exiting.");
      process.exit(130);
    });
  }

  await cleanup();
  const admin = (await pool.query(`SELECT id,username,name,role FROM users WHERE role='Admin' ORDER BY id LIMIT 1`)).rows[0];
  token = jwt.sign({ id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    process.env.JWT_SECRET, { expiresIn: "1h" });
  await pool.query(`INSERT INTO sites (name) VALUES ($1) ON CONFLICT DO NOTHING`, [SITE]);
  empId = (await pool.query(
    `INSERT INTO employees ("fullName","employeeNo",position,site,"employmentStatus","payType","dailyRate","monthlyRate")
     VALUES ($1,$2,'Security Guard',$3,'Active','Daily',$4,0) RETURNING id`, [GUARD, EMPNO, SITE, RATE])).rows[0].id;
  for (let d = 16; d <= 31; d++) {
    const day = `2026-10-${d}`;
    await pool.query(
      `INSERT INTO shift_assignments ("employeeId","guardName",site,"shiftName","startTime","endTime",
         "crossesMidnight","dutyDate","shiftKind","createdBy")
       VALUES ($1,$2,$3,'Day Shift','06:00','18:00',false,$4::date,'Day','zzov')`, [empId, GUARD, SITE, day]);
    await pool.query(`INSERT INTO attendance_records ("guardName",site,"punchType","punchAt") VALUES ($1,$2,'IN',$3)`, [GUARD, SITE, ph(day, "06:00")]);
    await pool.query(`INSERT INTO attendance_records ("guardName",site,"punchType","punchAt") VALUES ($1,$2,'OUT',$3)`, [GUARD, SITE, ph(day, "18:00")]);
  }
  periodId = (await (await api("/payroll/periods", { method: "POST", body: JSON.stringify({ periodStart: FROM, periodEnd: TO }) })).body).id
    || (await pool.query(`SELECT id FROM payroll_periods WHERE "periodStart"=$1::date`, [FROM])).rows[0].id;

  // ---- the poisoned base, exactly as the incident had it -------------------
  console.log("=== SETUP: the PhilHealth rate typo (0.025 instead of 5) ===");
  await setRate(0.025);
  await compute();
  const poisoned = await storedPh();
  console.log(`  engine assesses PhilHealth ${poisoned}`);
  check("  the poisoned base is reproduced", poisoned, 2.14);

  // ---- validation ---------------------------------------------------------
  console.log("\n=== 1. VALIDATION at the API ===");
  const post = (body) => api(`/payroll/periods/${periodId}/overrides`, { method: "POST", body: JSON.stringify(body) });
  const good = { employeeId: empId, fieldName: "philhealthEe", value: 400,
    reason: "Employee disputed the premium; corrected pending PhilHealth confirmation.",
    reasonCategory: "Employee dispute" };
  check("  a DERIVED total is refused", (await post({ ...good, fieldName: "netPay" })).status, 400);
  check("  an unknown field is refused", (await post({ ...good, fieldName: "wibble" })).status, 400);
  check("  a blank reason is refused", (await post({ ...good, reason: "   " })).status, 400);
  check("  a too-short reason is refused", (await post({ ...good, reason: "typo" })).status, 400);
  check("  a statutory override with no category is refused",
    (await post({ ...good, reasonCategory: undefined })).status, 400);
  check("  a non-numeric value is refused", (await post({ ...good, value: "abc" })).status, 400);
  check("  null is refused, NOT read as zero", (await post({ ...good, value: null })).status, 400);
  check("  a negative value is refused", (await post({ ...good, value: -5 })).status, 400);
  const created = await post(good);
  check("  a well-formed statutory override is accepted", created.status, 201);
  check("  ...and snapshots the CURRENT computed value",
    Number(created.body.override.computedValue), 2.14);
  check("  ...classified statutory", created.body.override.fieldClass, "statutory");
  check("  ...active", created.body.override.status, "active");

  // ---- the override takes effect on recompute -----------------------------
  console.log("\n=== 2. it applies on RECOMPUTE, not before ===");
  check("  the stored line is untouched until recomputed", await storedPh(), 2.14);
  const r2 = await compute();
  check("  after recompute the override is in effect", await storedPh(), 400);
  check("  ...and nothing is flagged yet", r2.body.staleOverrides, []);

  // ---- Approve is allowed while the override is sound ---------------------
  console.log("\n=== 3. Approve is ALLOWED while the override rests on its own base ===");
  const ap1 = await api(`/payroll/periods/${periodId}/approve`, { method: "PATCH" });
  check("  approve succeeds", ap1.status, 200);
  await pool.query(`UPDATE payroll_periods SET status='Computed' WHERE id=$1`, [periodId]);

  // ---- THE WORKED EXAMPLE -------------------------------------------------
  console.log("\n=== 4. THE INCIDENT: the rate is repaired, 2.14 -> 427.50 ===");
  await setRate(5);
  const r3 = await compute();
  const flagged = await ovRow();
  console.log(`  recompute reports: ${JSON.stringify(r3.body.staleOverrides)}`);
  check("  the override is FLAGGED stale", flagged.status, "stale");
  check("  ...recording what the engine now computes", Number(flagged.staleComputedValue), 427.5);
  check("  ...while KEEPING the original snapshot", Number(flagged.computedValue), 2.14);
  check("  ...and the override value is unchanged", Number(flagged.overrideValue), 400);
  check("  the override is STILL APPLIED, not auto-cleared", await storedPh(), 400);
  check("  the recompute NAMES it, not just counts it",
    r3.body.staleOverrides.map((o) => [o.fieldName, o.engineNowComputes]),
    [["philhealthEe", 427.5]]);

  console.log("\n=== 5. and it BLOCKS Approve ===");
  const ap2 = await api(`/payroll/periods/${periodId}/approve`, { method: "PATCH" });
  check("  approve is refused with 409", ap2.status, 409);
  check("  ...with a machine-readable code", ap2.body.code, "stale_overrides");
  check("  ...naming the guard and field", ap2.body.staleOverrides.map((o) => o.fieldName), ["philhealthEe"]);
  check("  ...and both figures, so the reviewer can decide",
    [Number(ap2.body.staleOverrides[0].overriddenWhenEngineSaid),
      Number(ap2.body.staleOverrides[0].engineNowComputes)], [2.14, 427.5]);
  const stillComputed = (await pool.query(`SELECT status FROM payroll_periods WHERE id=$1`, [periodId])).rows[0].status;
  check("  ...and the period really did not advance", stillComputed, "Computed");

  console.log("\n=== 6. RE-CONFIRM clears the flag and re-bases the snapshot ===");
  const rc = await api(`/payroll/overrides/${flagged.id}/reconfirm`, { method: "PATCH" });
  check("  reconfirm succeeds", rc.status, 200);
  const after = await ovRow();
  check("  status back to active", after.status, "active");
  check("  the snapshot is now the NEW base", Number(after.computedValue), 427.5);
  check("  the stale figure is cleared", after.staleComputedValue, null);
  check("  who re-confirmed is recorded", !!after.reconfirmedBy, true);
  check("  the override value never moved", Number(after.overrideValue), 400);
  const ap3 = await api(`/payroll/periods/${periodId}/approve`, { method: "PATCH" });
  check("  Approve now succeeds", ap3.status, 200);
  await pool.query(`UPDATE payroll_periods SET status='Computed' WHERE id=$1`, [periodId]);
  const r4 = await compute();
  check("  a further recompute does NOT re-flag it", r4.body.staleOverrides, []);

  console.log("\n=== 7. a period holding an override cannot be DELETED ===");
  const del = await api(`/payroll/periods/${periodId}`, { method: "DELETE" });
  check("  refused with 409", del.status, 409);
  check("  ...with a code", del.body.code, "period_has_overrides");
  check("  ...naming what would be lost", del.body.overrides.map((o) => o.fieldName), ["philhealthEe"]);

  console.log("\n=== 8. REMOVAL needs a reason, and the audit outlives the row ===");
  check("  removal without a reason is refused",
    (await api(`/payroll/overrides/${flagged.id}`, { method: "DELETE", body: "{}" })).status, 400);
  const rm = await api(`/payroll/overrides/${flagged.id}`,
    { method: "DELETE", body: JSON.stringify({ reason: "PhilHealth confirmed the full premium is correct." }) });
  check("  removal with a reason succeeds", rm.status, 200);
  check("  the row is gone", await ovRow(), undefined);
  const r5 = await compute();
  check("  the computed value takes effect on the next recompute", await storedPh(), 427.5);
  check("  ...and nothing is flagged", r5.body.staleOverrides, []);
  const delOk = await api(`/payroll/periods/${periodId}`, { method: "DELETE" });
  check("  the period can now be deleted", delOk.status, 200);

  console.log("\n=== 9. the AUDIT TRAIL is the surviving record ===");
  const audit = (await pool.query(
    `SELECT action, detail FROM audit_log WHERE action LIKE 'payroll_override%' AND detail LIKE '%ZZOV%'
      ORDER BY id`)).rows;
  for (const a of audit) console.log(`  ${a.action.padEnd(30)} ${a.detail.slice(0, 108)}`);
  const actions = audit.map((a) => a.action);
  check("  every step is recorded",
    ["payroll_override_set", "payroll_override_stale", "payroll_override_reconfirmed", "payroll_override_removed"]
      .filter((a) => !actions.includes(a)), []);
  const removed = audit.find((a) => a.action === "payroll_override_removed").detail;
  check("  the removal entry carries the override VALUE", removed.includes("400"), true);
  check("  ...the computed value it stood against", removed.includes("427.5"), true);
  check("  ...the original reason", removed.includes("Employee disputed"), true);
  check("  ...and why it was withdrawn", removed.includes("PhilHealth confirmed"), true);

  await restoreRate();
  await cleanup();
  await pool.end();
  console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILURE(S)"}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("HARNESS ERROR", e);
  try { await restoreRate(); await cleanup(); await pool.end(); } catch { /* */ }
  process.exit(1);
});
