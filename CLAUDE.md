# CSOMS — Central Security Operations Management System

Internal system for **TEKM Security Agency** (formerly branded Brookside Farms):
guard operations, HR, attendance, and payroll.

> **Maintenance rule — keep this current.**
> Whenever a feature is added, changed, or removed, update the Feature Inventory
> below in the same commit. A feature is not done until it is listed here. Also
> update *Known Gaps* when one is closed or a new one is accepted.

---

## Stack & layout

| | |
|---|---|
| Backend | Node + Express (`src/`), raw SQL, no ORM |
| Database | PostgreSQL on Neon |
| Frontend | React 19 + Vite + React Router (`frontend/`), served at `/app` |
| Deploy | Render, auto-deploys on push to `main`; Docker builds the frontend |
| Auth | JWT bearer token in `sessionStorage`; roles **Admin / Investigator / Viewer** |

```
src/server.js        mounts every /api/* router
src/db.js            schema + seeds; runs on every boot, must stay idempotent
src/routes/*.js      one router per module
src/lib/*.js         shared pure logic (see below)
frontend/src/pages/  one page per module
public/*.html        legacy app at "/" + unauthenticated forms
```

**Shared libraries** — logic lives here when two callers must never disagree:
- `payrollEngine.js` — all pay maths (pure, no DB)
- `phTime.js` — PH (UTC+8) time handling and night-window maths
- `leaveCredits.js` — leave day-counting and credit buckets
- `employeeHelpers.js`, `incidentHelpers.js` — record assembly + audit log

**Commands**
```bash
npm start                       # server (runs migrations first)
cd frontend && npm run build    # required before the server can serve /app
cd frontend && npm run lint
```

---

## Feature Inventory

### Core Layer
| Module | Capabilities |
|---|---|
| **Employee Master File (201 File)** | Personal details, government IDs (SSS/PhilHealth/Pag-IBIG/TIN), pay rate + tax-exempt flag, education, employment history, document uploads with expiry tracking, per-employee audit trail |
| **Attendance & Timekeeping** | Selfie + GPS punch capture via public link; register with search, site/guard/type filters and date range; reports for Daily Attendance, Late & Undertime, Overtime; Excel + branded PDF export; absence monitoring with follow-ups; Missing Time Log requests with single and **mass** approval. Reviewing a request settles the matching absence follow-up automatically — Approved → **Actioned**, Rejected → **Excused** |
| **Leave Management** | Requests with approval workflow; VL/SL credit balances; automatic paid/LWOP split on approval; guard vs non-guard day counting; approved leave suppresses "Absent" in attendance |
| **Payroll & Benefits** | Semi-monthly periods; Daily/Monthly rates; attendance-driven gross pay; night differential; holiday pay; statutory deductions; withholding tax; arrears carry-forward; pay components; 13th-month pay; payslip + register PDFs. Salary computation list itemises **Basic Pay, Night Differential, Built-in OT and Excess OT** as separate peso columns (see detail below) |
| **Recruitment & Onboarding** | Applicant pipeline, interview notes, background/medical/licence checks, onboarding checklist, equipment issuance, attachments |

### Operation Layer
| Module | Capabilities |
|---|---|
| **Security Operations Dashboard** | KPI cards, pie/column charts, trend filters |
| **Incident Reporting & Investigation** | Incidents with evidence, witnesses, corrective actions, attachments, PDF report, Excel export, public reporting form |
| **Deployment & Post Management** | Site profiles, post orders, deployment planning, reliever management, vacancy tracking, manpower requirements |
| **Shift Scheduling** | Shift templates and per-day roster; `crossesMidnight` derived from the times; explicit rest days that restore the prior shift when removed |
| **Daily Security Report** | Per-shift DSR with Draft→Submitted→Approved/Rejected workflow, attachments, PDF, public submission form |

### Compliance Layer
Disciplinary Action (NTE → hearing → penalty) · Performance Appraisal (KPI scoring) ·
Training & Certification (expiry tracking) · Compliance & Audit (checklists + corrective actions).
All four share a list → detail-modal → workflow → attachments → PDF shape.

### System Administration
Manage Users · **Manage Lists** (classifications, sites, 19 dropdown lists, **Pay Components**, **Holidays**) ·
System Settings (company name + logo, used across the app and PDFs) · Live Feed (cross-module audit).

### Public (unauthenticated) forms
`report.html` incident · `dsr-report.html` · `attendance.html` punch · `my-attendance.html` ·
`missing-timelog.html` · `leave-request.html` · `overtime-request.html`

---

## Payroll detail

**Pay computation** is per-day, then summed (`payrollEngine.js`):

| Scenario | Rate |
|---|---|
| Ordinary day, regular hours | 100% |
| Ordinary day, OT | 125% |
| Night hours 22:00–06:00 | +10% of the day's **base** rate — every hour in the window counts, including hours inside OT, but they are not uplifted by the OT multiplier (that premium is already paid by the OT columns). The holiday multiplier still applies. |
| Regular holiday — unworked / worked / OT | 100% / 200% / 260% |
| Special non-working — unworked / worked / OT | 0% / 130% / 169% |

- **Built-in OT** — shift length beyond 8h is auto-recognised (a 12h shift = 8h + 4h), earned by time actually worked past the 8-hour mark. No approval needed.
- **Excess OT** — worked past shift end, beyond a threshold. Requires approval.
- **Statutory** — SSS / PhilHealth / Pag-IBIG withheld on a configurable cutoff (default: 16th–end only). Withholding tax is assessed **every** cutoff with half the month's contributions in the tax base, so both payslips carry an even tax burden.
- **Tax** can be switched off company-wide, or per employee (`taxExempt`, for minimum-wage earners under RA 9504).
- **Arrears** — deductions are capped at gross so net can never go negative; the shortfall carries to the next cutoff. Priority: current statutory → voluntary → prior arrears. Balances move **only at Mark Paid**, so recomputing a draft can't double-count.
- **Holidays** — two axes: `type` sets the multiplier, `sites` sets who it applies to (empty = nationwide, populated = a local holiday).
- **`payroll_line_days`** records each day's classification and pay so a premium can be explained in a pay dispute.

**Period workflow:** Draft → Computed → Approved → Paid. Paid locks the period.

---

## Conventions that matter

- **Times.** Punches are UTC instants; guards work PH time (UTC+8, no DST). Always convert via `phTime.js`. `to_char` on a `timestamptz` renders in the *session* timezone (UTC on the server) — use `AT TIME ZONE 'Asia/Manila'` when formatting for display.
- **Migrations.** `src/db.js` runs on every boot. Everything must be `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, and backfills need a guard flag so they can't re-apply.
- **Money.** Never hardcode statutory figures or premium multipliers — they live in `payroll_statutory_config` and are admin-editable.
- **History.** Computed rows snapshot names/rates so later edits don't rewrite the past. Catalog entries deactivate rather than delete.
- **Authenticated downloads.** PDFs sit behind `requireAuth`; use `apiBlobUrl` + `downloadBlobUrl`. `window.open` cannot attach the bearer token and returns 401.
- **Sticky tables.** `.section-card` sets `overflow:hidden`, which captures `position:sticky`. Use `.sticky-card` + `.sticky-head`; offsets come from `lib/stickyOffsets.js` and `--module-header-h`.
- **Errors.** Express 4 does not catch async route errors. Handle them in the route — the process guards in `server.js` only prevent a crash, they don't answer the request.

---

## Known gaps

1. **Statutory tables are placeholder figures**, not verified issuances — they must be replaced with real SSS / PhilHealth / Pag-IBIG / BIR values before any live payroll run.
2. **Rest-day premium is not implemented.** A holiday falling on a rest day pays the plain holiday rate, not the compounded 260%/150%.
3. **Only fixed-date national holidays are seeded.** Movable feasts and all local holidays need manual entry each year.
4. **Leave paid/LWOP days** spanning two cutoffs are allocated proportionally, because `leave_records` stores an aggregate split rather than a per-day one.
5. **Legacy app at `/`** still serves the pre-React UI; `/app` is the React version. See `REACT-MIGRATION-PLAN.md`.
