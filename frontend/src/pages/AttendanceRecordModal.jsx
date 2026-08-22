import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";

// One guard's daily time record for one semi-monthly payroll period.
//
// READ-ONLY, deliberately and completely: no input, no button that writes, no
// PATCH or POST anywhere in this file. Corrections happen on the register,
// which is where the site-mismatch and issued-period guards live — a timesheet
// that could edit would be a second, unguarded path to the same data.

// Semi-monthly halves, DERIVED from the calendar rather than read from a table:
// the 1st-15th and the 16th-end of each month, matching periodsPerMonth = 2.
// There is no payroll_periods row to depend on, so a period always exists to
// look at even before payroll has been set up for it.
function halvesEndingNow(count = 12) {
  const now = new Date();
  // Work in PH time: a period boundary read in the browser's zone would flip a
  // day early or late for anyone outside UTC+8.
  const ph = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  let y = ph.getFullYear(), m = ph.getMonth() + 1;
  let second = ph.getDate() >= 16;
  const out = [];
  for (let i = 0; i < count; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${y}-${String(m).padStart(2, "0")}-${second ? "16" : "01"}`;
    const to = `${y}-${String(m).padStart(2, "0")}-${String(second ? last : 15).padStart(2, "0")}`;
    out.push({ from, to, label: `${from} to ${to}` });
    if (second) second = false;
    else { second = true; m -= 1; if (m === 0) { m = 12; y -= 1; } }
  }
  return out;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Formatted from the YYYY-MM-DD string, never through a Date — parsing a date
// into an instant and reading it back is where every timezone defect here has
// come from, and there is nothing to convert.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateParts(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  // Day-of-week via a UTC instant built from the parts, which cannot drift:
  // no local-timezone parsing is involved.
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { label: `${MONTHS[m - 1]} ${String(d).padStart(2, "0")}`, dow };
}
const hhmm = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false });
};
const mins = (n) => (n > 0 ? String(n) : "");

function statusStyle(status) {
  if (status === "Absent") return { color: "var(--red)", fontWeight: 600 };
  if (status === "On Leave") return { color: "var(--blue)", fontWeight: 600 };
  if (status === "Rest Day") return { color: "var(--text-mute)" };
  if (status === "Pending site review") return { color: "var(--amber, #b8860b)", fontWeight: 600 };
  return {};
}

export default function AttendanceRecordModal({ guardName, initialDate, onClose }) {
  const periods = useMemo(() => halvesEndingNow(12), []);
  // Open on the half containing the register's From date, so the modal starts
  // where the reader was already looking. Falls back to the current period when
  // the register has no date set, or when its range predates the offered
  // halves — never to a period nobody asked for.
  const [periodIdx, setPeriodIdx] = useState(() => {
    if (!initialDate) return 0;
    const i = periods.findIndex((p) => initialDate >= p.from && initialDate <= p.to);
    return i === -1 ? 0 : i;
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const period = periods[periodIdx];

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api(`/attendance-reports/timesheet?guard=${encodeURIComponent(guardName)}`
      + `&from=${period.from}&to=${period.to}`)
      .then((d) => { if (active) { setData(d); setLoading(false); } })
      .catch((e) => { if (active) { setError(e.message); setLoading(false); } });
    return () => { active = false; };
  }, [guardName, period.from, period.to]);

  // Period totals, summed from the rows already on screen so the footer can
  // never disagree with the body above it.
  const totals = useMemo(() => {
    const t = { present: 0, absent: 0, restDay: 0, onLeave: 0, late: 0, undertime: 0, builtin: 0, excess: 0 };
    for (const day of (data && data.days) || []) {
      for (const e of day.entries) {
        if (e.status === "Absent") t.absent++;
        else if (e.status === "Rest Day") t.restDay++;
        else if (e.status === "On Leave") t.onLeave++;
        else t.present++;
        t.late += e.lateMin; t.undertime += e.undertimeMin;
        t.builtin += e.builtinOtMin; t.excess += e.excessOtMin;
      }
    }
    return t;
  }, [data]);

  const emp = (data && data.employee) || null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1180, width: "96vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>View Attendance Record</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="modal-body">
          <div className="form-field" style={{ maxWidth: 320, marginBottom: 12 }}>
            <label htmlFor="dtr-period">Payroll period</label>
            <select id="dtr-period" value={periodIdx} onChange={(e) => setPeriodIdx(Number(e.target.value))}>
              {periods.map((p, i) => (
                <option key={p.from} value={i}>{p.label}{i === 0 ? " (current)" : ""}</option>
              ))}
            </select>
          </div>

          {/* Header block, as the paper form carries it. */}
          <div className="section-card" style={{ marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, fontSize: 12.5 }}>
              <div><div style={{ color: "var(--text-mute)", fontSize: 11 }}>Payroll Period</div>
                <strong>{period.from} to {period.to}</strong></div>
              <div><div style={{ color: "var(--text-mute)", fontSize: 11 }}>Employee Number</div>
                <strong>{(emp && emp.employeeNo) || "—"}</strong></div>
              <div><div style={{ color: "var(--text-mute)", fontSize: 11 }}>Name</div>
                <strong>{(emp && emp.fullName) || guardName}</strong></div>
              <div><div style={{ color: "var(--text-mute)", fontSize: 11 }}>Position</div>
                <strong>{(emp && emp.position) || "—"}</strong></div>
              <div>
                <div style={{ color: "var(--text-mute)", fontSize: 11 }}>Site</div>
                {/* DERIVED: the most-rostered site for THIS period, so a guard who
                    moved posts mid-month reads differently for each half. */}
                <strong>{(data && data.site) || "No rostered site"}</strong>
              </div>
            </div>
          </div>

          {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}
          {loading && <p style={{ color: "var(--text-mute)" }}>Loading timesheet…</p>}

          {!loading && !error && data && (
            <div className="section-card" style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Shift IN</th>
                    <th>Shift OUT</th>
                    <th>Log IN</th>
                    <th>Log OUT</th>
                    <th>Status</th>
                    <th>Late</th>
                    <th>Undertime</th>
                    <th>Built-in OT</th>
                    <th>Excess OT</th>
                    <th>Leave</th>
                    <th>Rest Day</th>
                    <th>Missing Time Log</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day) => {
                    const { label, dow } = dateParts(day.dutyDate);
                    // A date the roster never touched still gets a line — the
                    // paper form has one per day, and a gap reads as a fault.
                    const entries = day.entries.length ? day.entries : [null];
                    return entries.map((e, i) => (
                      <tr key={`${day.dutyDate}|${i}`}>
                        <td data-label="Date">{i === 0 ? label : ""}</td>
                        <td data-label="Day">{i === 0 ? dow : ""}</td>
                        {/* Blank on a rest day or an unrostered date — there was
                            no schedule; the Status column carries the reason. */}
                        <td data-label="Shift IN">{(e && e.startTime) || ""}</td>
                        <td data-label="Shift OUT">{(e && e.endTime) || ""}</td>
                        <td data-label="Log IN">{e ? hhmm(e.timeIn) : ""}</td>
                        <td data-label="Log OUT">{e ? hhmm(e.timeOut) : ""}</td>
                        <td data-label="Status" style={e ? statusStyle(e.status) : {}}>
                          {e ? e.status : ""}
                          {e && e.flags.includes("No time-out") && (
                            <div style={{ fontSize: 10.5, color: "var(--red)" }}>No time-out</div>
                          )}
                        </td>
                        <td data-label="Late">{e ? mins(e.lateMin) : ""}</td>
                        <td data-label="Undertime">{e ? mins(e.undertimeMin) : ""}</td>
                        <td data-label="Built-in OT">{e ? mins(e.builtinOtMin) : ""}</td>
                        <td data-label="Excess OT">{e ? mins(e.excessOtMin) : ""}</td>
                        <td data-label="Leave">{(e && e.leaveType) || ""}</td>
                        <td data-label="Rest Day">{e && e.isRestDay ? "Yes" : ""}</td>
                        <td data-label="Missing Time Log">
                          {i === 0 && day.filings.map((f) => (
                            <div key={f.id} style={{ fontSize: 10.5 }}>
                              {f.missingType} — <strong>{f.status}</strong>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600 }}>
                    <td colSpan={6}>Period totals</td>
                    <td>{totals.present} present · {totals.absent} absent · {totals.restDay} rest · {totals.onLeave} leave</td>
                    <td>{mins(totals.late)}</td>
                    <td>{mins(totals.undertime)}</td>
                    <td>{mins(totals.builtin)}</td>
                    <td>{mins(totals.excess)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
              <p style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 8 }}>
                Minutes. <strong>Built-in OT</strong> is overtime inherent to the rostered shift beyond eight
                hours; <strong>Excess OT</strong> is time worked past the rostered end. This record is read-only —
                corrections are made on the Attendance Register.
              </p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
