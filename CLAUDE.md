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
- `billingEngine.js` — all client-billing maths (pure, no DB)
- `phTime.js` — PH (UTC+8) time handling and night-window maths
- `leaveCredits.js` — leave day-counting and credit buckets
- `pdfMoney.js` — money formatting for PDFs (never `₱`; see *Conventions*)
- `assetHelpers.js` — asset availability and alert derivation (pure, no DB)
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
| **Billing & Statement of Account** | Clients each owning detachments; per-site contract rate, duty hours and contracted headcount (inheriting client → agency defaults); billing periods independent of payroll with Draft → Issued → Paid; LESS/ADD man-hours auto-derived from attendance and overridable; per-day evidence behind every figure; SOA PDF per detachment (or the whole run) plus a computation-sheet register; admin-editable fee percentages (see detail below) |
| **Asset & Equipment Management** | Register of every trackable item, security and non-security; three-level **Asset Type → Category → Sub-Category** classification, admin-maintainable and **owned solely by this module**; serialized and bulk tracking; issue → return with partial returns, loss and damage write-offs; **Equipment Accountability Form** PDF per issuance, on the agency letterhead with logo, downloadable straight from the issue dialog; inventory PDF; attachments; alerts for overdue returns, returns due soon, warranty/replacement, and low stock (see detail below) |
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
System Settings (company name + logo + **SOA letterhead**: tagline, address, mobile, email, owner name and
position — used across the app and every PDF) · Live Feed (cross-module audit).

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

## Billing detail

Billing is the mirror of payroll: payroll pays guards for what they worked,
billing charges clients for the same facts. Both read the **same**
`computeReport()` from `attendance-reports.js`, so the two can never disagree
about who was on post.

Per detachment, per period (`billingEngine.js`, reproducing the agency's
"Billing Auto Compute Template"):

```
manHourRate       = contractRate / 365            ← unusual; see Known Gaps
billingPeriodRate = (contractRate / 2) × guards
billingCost       = (billingPeriodRate + addAmount) − lessAmount
adminFee          = billingCost × 12.24%
dueForGuard       = billingCost − adminFee
withholdingTax    = adminFee × 2%
netAmount         = billingCost − withholdingTax     ← "Please pay this amount"
```

- **Derived adjustments.** LESS = service the client paid for and didn't
  receive (absent / on leave → the whole shift; undertime and late → the hours
  the post stood unmanned). ADD = service beyond the contract (a duty day
  worked with no roster entry — reliever or extra post; and **excess** OT).
  Built-in OT is never ADD: it is inside the contracted 12-hour shift.
  Rest days never produce a LESS.
- **Overrides.** Each quantity is stored three ways — `derived*` (refreshed
  every recompute), `*Override` (never touched by recompute), and the plain
  effective column, `override ?? derived`. Pressing Recompute therefore cannot
  discard a deliberate edit, and clearing an override restores the attendance
  figure.
- **`billing_line_days`** records every day behind a derived figure, so a
  disputed statement can be answered day by day.
- **Guard count** comes from the contract (`contractedGuards`), not the roster:
  two guards alternating one post is still one billed post. The roster-derived
  count is stored beside it so a mismatch is visible.
- **Rounding.** Every figure rounds to centavos as produced, so the printed
  statement foots. The spreadsheet carries full precision and rounds only for
  display, which makes its own note block sum a centavo short of the total it
  prints beside it. Divergence is never more than a centavo per line.
- **Statement numbers** are one series, `PREFIX-YYYY-NNN`, assigned at Issue —
  one per billing run, printed on every detachment page, as the agency's
  template does.

**Period workflow:** Draft → Issued → Paid. Issued freezes the figures and
stamps the number; Reopen returns an unpaid statement to Draft, keeping its
number. Paid locks it.

---

## Asset & Equipment detail

**Classification** is `asset_types` → `asset_categories` → `asset_subcategories`,
each level admin-maintainable from the module's own Classification tab.

> These lists are **not** in `dropdown_options` and must never be moved there.
> They are hierarchical, they exist only to classify assets, and nothing
> outside this module may consume them. Manage Lists is for flat lists shared
> across modules; this is neither.

- Assets store both the foreign key *and* the resolved name at each level. A
  **rename** propagates to the assets under it (it is the same thing, spelled
  better); a **reclassification** does not rewrite history.
- A level in use cannot be deleted — deactivate it instead. Deleting would
  leave assets unclassified.
- The taxonomy is seeded only when `asset_types` is empty, like `DROPDOWN_SEEDS`.
  Without that guard every boot would restore entries an admin had deleted.

**Tracking mode** is what lets one table hold both a radio and a stack of shirts:

| | |
|---|---|
| **Serialized** | One physical unit. Quantity is always 1; `status` says where it is. |
| **Bulk** | A pooled stock. `quantity` is what is owned. |

- **Availability is derived, never stored** — owned less whatever is
  outstanding in `asset_issuances`, so stock can never drift from the ledger.
  A serialized item is also unavailable when its status is Under Repair, Lost
  or Retired, even though nobody holds it.
- **Nothing sets `status = 'Issued'` by hand.** It is re-derived from the open
  issuances after every issue and return. Manual states (Under Repair / Lost /
  Retired) are deliberate statements about the item and are never overwritten.
- Issuing locks the asset row `FOR UPDATE`, so two people cannot both be handed
  the last radio.
- Bulk stock cannot be edited below what is currently out on issue.
- A return carrying condition **Damaged** moves the asset to Under Repair; a
  **Lost** outcome marks it Lost. Neither is then offered for issue.
- Deleting an asset that has issuance history **retires** it instead — the
  record of who held what is evidence.
- The **Equipment Accountability Form** (`EAF-nnnnn`) is the signed record of a
  hand-over. Its letterhead — name, logo, tagline, address, mobile, email —
  comes from System Settings, so nothing about the agency is hardcoded. The
  form's "Issued by" carries the owner's title **only when the owner issued
  it**; otherwise the issuer signs as an authorised representative, so a
  storekeeper is never printed as the General Manager.
- **Alerts are derived on read, never stored** (an alert is a fact about
  today): overdue returns, due within 7 days, warranty/replacement within 30
  days, and bulk stock at or below its reorder level. "Today" is PH local.

---

## Conventions that matter

- **Times.** Punches are UTC instants; guards work PH time (UTC+8, no DST). Always convert via `phTime.js`. `to_char` on a `timestamptz` renders in the *session* timezone (UTC on the server) — use `AT TIME ZONE 'Asia/Manila'` when formatting for display.
- **Migrations.** `src/db.js` runs on every boot. Everything must be `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, and backfills need a guard flag so they can't re-apply.
- **Money.** Never hardcode statutory figures or premium multipliers — they live in `payroll_statutory_config` and are admin-editable. Billing's commercial terms (fee percentages, the man-hour divisor, default rates) live in `billing_config` for the same reason.
- **Money in PDFs.** Use `pdfMoney.js` — **"PHP 8,550.00", never `₱`**. PDFKit's built-in fonts are WinAnsi-encoded, so `₱` (U+20B1) is written as byte `0xB1` and renders as `±`. The web UI is unaffected and still shows `₱`.
- **History.** Computed rows snapshot names/rates so later edits don't rewrite the past. Catalog entries deactivate rather than delete.
- **Configurable lists.** Flat lists shared by several modules live in `dropdown_options` and are maintained from Manage Lists. A list that is hierarchical, or that only one module can meaningfully consume, gets its own tables and its own tab inside that module — see the asset taxonomy.
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
6. **The billing man-hour rate divides a MONTHLY rate by 365.** Reproduced from the agency's spreadsheet and applied consistently there, but it is an unusual derivation. It is editable (`billing_config.manHourDivisor`) — confirm it against the signed client contract before issuing real statements.
7. **Detachment names must be mapped by hand.** The roster's site name ("BBGC") is not the statement's post name ("BBGC Farms"). Unmapped sites are listed on Clients & Detachments rather than matched automatically, so nothing is billed until an admin maps it.
8. **VAT is not modelled** in billing — the agency's template has none. Only the 2% withholding tax is applied.
