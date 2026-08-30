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
| Auth | JWT bearer token in `sessionStorage`; **7 roles** + per-user, per-module Add/Edit/Delete privileges (see *Access privileges*) |

```
src/server.js        mounts every /api/* router
src/db.js            schema + seeds; runs on every boot, must stay idempotent
src/routes/*.js      one router per module
src/lib/*.js         shared pure logic (see below)
frontend/src/pages/  one page per module
frontend/src/components/  shared UI + the app-wide hosts (see *UI layer*)
frontend/src/lib/    frontend helpers: confirm(), prompt(), toast(), sticky offsets
public/*.html        legacy app at "/" + unauthenticated forms
```

**Shared libraries** — logic lives here when two callers must never disagree:
- `payrollEngine.js` — all pay maths (pure, no DB)
- `billingEngine.js` — all client-billing maths, including the site-level
  man-hour derivation and IN/OUT pairing (pure, no DB)
- `phTime.js` — PH (UTC+8) time handling and night-window maths
- `leaveCredits.js` — leave day-counting and credit buckets
- `pdfMoney.js` — money formatting for PDFs (never `₱`; see *Conventions*)
- `assetHelpers.js` — asset availability and alert derivation (pure, no DB)
- `payoutDetails.js` — payout destination validation and masking (pure, no DB)
- `xenditChannels.js` — internal payout choice → payment-provider channel code
- `disbursementFile.js` — the disbursement CSV (pure, no DB)
- `ddoHelpers.js` — duty-detail-order numbering, validity and conflict checks (pure, no DB)
- `mdrHelpers.js` — Monthly Disposition Report figures **and every validation rule** (pure, no DB)
- `educationRank.js` — the ordered education levels; their order **is** the attainment rank (pure, no DB)
- `permissions.js` — roles, modules, and the Add/Edit/Delete matrix (pure, no DB)
- `appBranding.js` — author/licence strings (mirrored at `frontend/src/appBranding.js`)
- `appVersion.js` — the running commit, resolved once at boot (pure, no DB)
- `dutyForPunch.js` — which rostered duty a punch belongs to, resolved by proximity
  (`pickOwningDuty()` is pure; `dutyForPunch()` adds the two-day candidate query)
- `pdfBranding.js` — the footer stamped on every page of every PDF
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
| **Employee Master File (201 File)** | Register **sortable by Employee No and Full Name** (click to sort ascending, click again to reverse); personal details, government IDs (SSS/PhilHealth/Pag-IBIG/TIN/**LESP number + category + expiry**, category from Manage Lists), pay rate + tax-exempt flag, **payout details** (GCash / Maya / GoTyme / bank, masked on display), **National Police Clearance expiry and last medical / neuro / drug-test dates**, education with a **derived Highest Educational Attainment**, employment history, document uploads with expiry tracking, per-employee audit trail |
| **Attendance & Timekeeping** | Selfie + GPS punch capture via public link, behind a **confirmation panel naming the duty site**, a **server-side rejection of a resubmitted punch** (see *Duplicate punches on the public form*) and a **hard block on a roster-mismatched site unless the guard declares Relief / Coverage** (see *Declared relief / coverage*); register with search, site/guard/type filters and date range; reports for Daily Attendance, Late & Undertime, Overtime; Excel + branded PDF export; **unrostered duty days** (a punch on a day with no roster entry) shown as their own Present row rather than vanishing; absence monitoring with follow-ups; **read-only per-guard timesheet** (*View Attendance Record*) — one semi-monthly period at a time, rostered shift beside the actual log, status, late, undertime, **built-in and excess OT as separate columns**, leave, rest day and any Missing Time Log filing (see *The per-guard timesheet*); **inline correction of a record's SITE and RECORD type** on the register, with the issued-period freeze, the site-mismatch hold and the no-time-out hold all intact (see *Correcting a punch's site or record type*); **soft delete on the register** (a punch is retired, never erased — see *Retiring a punch*); **per-row delete on Daily Attendance** (removes the punch RECORDS behind a line — the line is derived from the roster and returns as Absent; Owner-only, per the matrix); Missing Time Log requests with single and **mass** approval, both of which **refuse to approve a duty date with no rostered shift** (see *Approving a correction* below). Reviewing a request settles the matching absence follow-up automatically — Approved → **Actioned**, Rejected → **Excused**. **Duty site is CHOSEN on both public forms, not copied from the 201 File** — a guard on relief duty works a post that is not their assigned one — and a choice that disagrees with the roster puts the day on a billing hold (see *Duty site detail*). The Missing Time Log form also takes an **optional stamped selfie and up to three JPEG/PNG/PDF attachments** |
| **Leave Management** | Requests with approval workflow; VL/SL credit balances; automatic paid/LWOP split on approval; guard vs non-guard day counting; approved leave suppresses "Absent" in attendance |
| **Payroll & Benefits** | Semi-monthly periods; Daily/Monthly rates; attendance-driven gross pay; night differential; holiday pay; statutory deductions; withholding tax; arrears carry-forward; pay components; 13th-month pay; payslip + register PDFs; **disbursement** of net pay to e-wallets and banks (see detail below). Salary computation list itemises **Basic Pay, Night Differential, Built-in OT and Excess OT** as separate peso columns (see detail below) |
| **Billing & Statement of Account** | Clients each owning detachments; per-site contract rate, standard shift hours and contracted headcount (inheriting client → agency defaults); billing periods independent of payroll with Draft → Issued → Paid. **A site-level man-hour model, anchored to the punch and ignoring the roster**: each site-day nets the man-hours actually worked against `contractedGuards × dutyHours` into ONE figure — short is a LESS, over is an ADD, never both. The flat period rate covers a **fixed standard period** set by the client's **billing cadence** (semi-monthly 2×15, monthly 1×30; admin-editable default), so a 16-day period augments the extra day and a 13-day February credits the two days that have no calendar date — plus **manual ADD** for billable overtime and two per-line **holiday-pay** amounts folded into the taxed base. **An incomplete IN/OUT pair counts zero, credits the client, and blocks Issue** until a Missing Time Log correction supplies the punch; sites with attendance but no detachment are surfaced. Per-day evidence behind every figure; SOA PDF per detachment (or the whole run) plus a computation-sheet register; admin-editable fee percentages, **optionally overridden per client** (see detail below) |
| **Asset & Equipment Management** | Register of every trackable item, security and non-security; three-level **Asset Type → Category → Sub-Category** classification, admin-maintainable and **owned solely by this module**; serialized and bulk tracking; issue → return with partial returns, loss and damage write-offs; **Equipment Accountability Form** PDF per issuance, on the agency letterhead with logo, downloadable straight from the issue dialog; inventory PDF; attachments; alerts for overdue returns, returns due soon, warranty/replacement, and low stock (see detail below) |
| **Recruitment & Onboarding** | Applicant pipeline, interview notes, background/medical/licence checks, onboarding checklist, equipment issuance, attachments |

### Operation Layer
| Module | Capabilities |
|---|---|
| **Security Operations Dashboard** | Incident KPI cards and pie charts; operational records — **Daily Manning** (Deployment Status), **Site Status** (Site Condition; no separate Notes — “Site note” is its free-text field), **Site Manning Status** (Complete / Incomplete / No Guards), **Patrol Video** (Video Patrol Status: Complete / Incomplete, plus a **Post Type**: Farm / Gate / Egg Store), **Visitor Count** and **Vehicle Count** (a count for a site on a date — no Description; Notes carries the rest). Guard names are **picked from the 201 File** (`Full Name — Employee No`), and all three status lists are admin-maintainable from Manage Lists. **Each of the six tabs carries its own analytics block** above the entry form — three KPI cards, a trend chart and a by-site breakdown, with site and period filters (see detail below) |
| **Incident Reporting & Investigation** | Incidents with evidence, witnesses, corrective actions, attachments, PDF report, Excel export, **public no-login report form** shared from this module. The JSON backup export and the in-module Activity log were removed at the agency's request — the cross-module audit lives in **Live Feed**, which is access-controlled |
| **Deployment & Post Management** | Site profiles, post orders, deployment planning, reliever management, vacancy tracking, manpower requirements, **Detail Duty Order** (see detail below) |
| **Shift Scheduling** | Shift templates and per-day roster **sortable by Employee No or Name** (click to sort ascending, click again to reverse); **each day cell names the site that day is rostered at** (see *Per-day site on the roster*); `crossesMidnight` derived from the times; **`shiftKind` (Day / Night / Straight Duty / Broken)** stated on the template and snapshotted onto **every** assignment; **broken (split) shifts** carrying a second time range on the same row; a **roster legend derived from the templates**, so a new shift type appears with no code change; explicit rest days that restore the prior shift — its kind and both ranges — when removed |
| **Daily Security Report** | Per-shift DSR with Draft→Submitted→Approved/Rejected workflow, attachments, PDF, **public no-login submission form** shared from this module |
| **Useful Links** | A directory of the external portals operations depends on — PNP-SOSIA, SSS, PhilHealth, BIR, vendor support. Name, URL, category, description and Active/Inactive status, with search and category/status filters. **Closed by default**: only *Owner / President / General Manager* (and Admin, inherently) holds it; everyone else is granted it per user from Manage Users. **URL Category is a Manage Lists list** (`url_category`), never hardcoded — so a category renamed there carries its links with it, and one still in use cannot be deleted. Only `http`/`https` are accepted, validated in the browser and again on the server; links open in a new tab with `rel="noopener noreferrer"` |
| **Security Reports** | The agency's statutory returns. **Monthly Disposition Report** (MDR) to the Regional Civil Security Unit: clients per province, guards under their LESP licences, firearms deployed, officers, and the month's gains and losses. Guards pull from the 201 File and firearms from the Asset register; Sections 1 and 3 are derived; every finding and the filing verdict come from one engine; landscape PDF (see detail below) |

### Executive Summary Layer
| Module | Capabilities |
|---|---|
| **Executive Summary** | Read-only leadership view. Live KPIs aggregated from the modules that already own the data — active headcount vs guards actually rostered, sites covered, attendance compliance with a prior-period trend, unexplained absences, open disciplinary cases, open and overdue compliance corrective actions — plus a breakdown showing exactly how the compliance rate is derived. Six charts (attendance and overtime by PH week, deployment by site, absence patterns, compliance-audit and disciplinary status), a period selector defaulting to **last 4 weeks** with an explicit **From/To date range**, a site filter, and a branded PDF export. **Closed by default**: only *Owner / President / General Manager* sees it, and an administrator grants it per user from Manage Users. |

### Compliance Layer
Disciplinary Action (NTE → hearing → penalty) · Performance Appraisal (KPI scoring) ·
Training & Certification (expiry tracking) · Compliance & Audit (checklists + corrective actions).
All four share a list → detail-modal → workflow → attachments → PDF shape.

### System Administration
Manage Users (7 roles + **Access privileges** per user, each module carrying View/Add/Edit/Delete plus a **Full access** shortcut that ticks all four, + **Reset password**, which issues a one-time temporary password and forces a change at next login) · **Change password** for your own account, from the sidebar footer · **Manage Lists** (classifications, sites, 20 dropdown lists incl. **LESP Category**, **Pay Components**, **Holidays**; values are **renameable with the records following**, cannot be deleted while in use, and carry a **Compliant** flag on the four lists the dashboard classifies by) ·
**Manage Lists → URL Category** feeds Useful Links; its values are consumed as
strings like every other list, and `src/lib/dropdownUsage.js` maps it so the
rename and delete-guard rules reach it ·
System Settings (company name + logo + **SOA letterhead**: tagline, address, mobile, email, owner name and
position; + **DDO letterhead**: LTO licence no.;
+ **MDR letterhead**: LTO expiry and a named contact person; + **Signatories**: Admin Officer and Operation Head, configured independently; + **Statutory filing**: the agency's region,
RCSU addressee and attention line, pre-filled onto every new Monthly Disposition Report)
· **Live Feed** (cross-module audit) — **closed**: the log names who did what in
every module, so it is limited to *Owner / President / General Manager* and
*Admin*. Hidden in the sidebar, guarded on the page, and refused by
`GET /incidents/_all/audit`, which was previously readable by any signed-in
user. Purging remains **Admin only**.

### Public (unauthenticated) forms
`report.html` incident · `dsr-report.html` · `attendance.html` punch ·
`my-attendance.html` · `missing-timelog.html` · `leave-request.html` ·
`overtime-request.html`

> **The incident and DSR forms were withdrawn in Stage A and REINSTATED
> (Aug 2026)** at the agency's request. Both pages, both `POST` routes in
> `routes/public.js`, and the `url` / `dsrUrl` keys on `/auth/public-form-link`
> are back exactly as they were; `server.js`'s **410 Gone** handler is gone with
> them. The one thing that changed is **where the link is shared from**: each
> form is now shared from its own module — *Incident Reporting & Investigation*
> and *Daily Security Report* — instead of from Manage Users, so an admin finds
> the link beside the register it feeds. The old Manage Users panel is removed.
>
> **The incident form identifies its reporter by EMPLOYEE NUMBER.** *Reporter
> type* is Employee (default) or Other / External. An employee enters a number,
> presses Validate, and the name comes back from the 201 File read-only — the two
> can never be paired wrongly. The server looks the number up AGAIN on submit and
> saves the authoritative name, so a payload naming a real number with someone
> else's name stores the real holder; the form is public and its body is whatever
> the sender typed. A separated employee is refused by the same rule the DDO and
> MDR use (`employmentStatus !== 'Active'`) — no new status definitions.
> External reporters type their own name and need no number.
>
> It reuses `/public/employee-lookup`, which the attendance and leave forms
> already use: token-gated, one number at a time, returning only the name, the
> site and now an `active` flag. That flag is ADDED, not substituted, so the
> other forms are unaffected. There is no way to ask it for a list.
> `incidents.reporterType` and `reporterEmployeeNo` are additive and left NULL on
> existing rows — those reports predate the choice, and calling them external
> would assert something nobody checked. `reportedBy` still holds the display
> name, so every existing incident reads exactly as before.
>
> Every public form is gated the same way and always has been: `requireFormToken`
> means nothing is reachable unless **`PUBLIC_FORM_TOKEN`** is set on the server,
> each `POST` carries a honeypot field a bot fills and a browser does not, and
> the routes are rate-limited to **30 requests per 15 minutes**, one counter
> shared by every public route. `POST /public/missing-timelog` additionally has
> its own **10 per 15 minutes** bucket: a submission there now costs five
> requests (meta, branding, sites, employee-lookup, the multipart POST), and
> guards at a detachment share one connection — six of them filing on the same
> afternoon would otherwise exhaust the shared budget and lock everyone at that
> site out of the ATTENDANCE PUNCH form. The inner limiter can only tighten,
> never loosen, since the shared one still applies first.
> `/public/sites` serves the Sites / Facilities list to the two forms that carry
> a duty-site picker, token-gated like `/public/leave-types`.
> `/public/meta` and `/public/branding` are shared
> by every one of them.
>
> **Sharing a link follows the matrix, not the Admin role.** The form creates a
> record in a module, so whoever may **add** there may hand out the form that
> adds it — `PUBLIC_FORM_MODULE` in `permissions.js` maps each link to its owner
> (the four attendance forms all belong to `attendance`). Sharing was Admin-only,
> which meant a user granted *full access* to Incidents still could not
> distribute the incident form; all seven buttons were gated on `isAdmin`.
> `/auth/public-form-link` now returns **only the links the caller is entitled
> to** rather than all seven, so an Incidents-only user cannot read the
> attendance, leave and overtime URLs out of the response body.
>
> **Excel and PDF were never role-gated** and needed no change — every
> `*.pdf` route is `requireAuth`, so `modulePermission` gates it on `view` like
> any other read, and the Excel file is built in the browser from the list
> already on screen. Measured, not assumed: a non-admin holding Incidents
> downloads the incident PDF (200, `application/pdf`) and one without it gets 403.

### UI layer
Bootstrap 5.3 is imported as a **CSS/utility layer only** — the JS bundle is
never imported and there is no `data-bs-*` attribute anywhere in
`frontend/src`. All dialogs stay state-driven React. Shared pieces:

| | |
|---|---|
| `components/KpiCard.jsx` | the one KPI tile: icon, tone, optional trend |
| `components/SortableTh.jsx` | the sortable column header shared by the 201 File register and the Weekly Roster, with `compareBy()` (numeric collation) and `nextSort()`. A real `<button>` inside the `<th>`, and `aria-sort` on the `<th>` |
| `components/StatusBadge.jsx` | takes a module's own `*BadgeClass` mapper, so adopting it changes nothing visually |
| `components/ConfirmModal.jsx` | the dialog `confirm()` renders |
| **Stacking** | every `.modal-overlay` is `z-index:1000`; the app-wide dialogs (confirm, prompt, Change password) add `.is-app-dialog` for **1050**. They are mounted in `AppShell`, which is earlier in the DOM than `.app-main`, so at equal z-index a page’s modal painted OVER the confirm its own delete button opened. Toasts stay above at 1100 |
| **Refresh** | every module header carries one, wired to that page’s OWN loader — never `window.location.reload()`, which would discard filters, scroll and the open tab, and re-download the bundle. Where the header sits in a shell whose tabs own their data (Assets, Billing, Payroll, Security Reports), the shell holds a `revision` counter that each tab lists in its load effect: a refetch without remounting, so the tab keeps its filters |
| `components/ModuleHeader.jsx` | `actions` + `utilityActions`, each a labelled `role="group"`. Carries **no** user block: who is signed in, Change password and Log out live in the sidebar footer, once for the whole app instead of on all 21 headers |
| `components/Sidebar.jsx` | nav + the pinned footer. The footer is the **last child of `.sidebar-scroll`**, not a sibling: below 820px that scroller becomes the slide-out panel and the sidebar collapses to a 52px bar, so a sibling would land in the bar beside the burger. `margin-top:auto` pins it when the nav is short, `position:sticky` once it scrolls |
| **App-wide hosts**, mounted once in `AppShell` | |
| `components/DialogBehavior.jsx` | focus trap, Escape, focus restore, scroll lock and ARIA for **every** dialog |
| `components/ConfirmHost.jsx` | serves `confirm()` |
| `components/PromptHost.jsx` | serves `prompt()` |
| `components/ToastHost.jsx` | serves `toast.*` |

**No native browser dialog remains.** `window.confirm` / `window.alert` /
`window.prompt` are replaced by `lib/confirm.js`, `lib/toast.js` and
`lib/prompt.js` — module-level functions served by the hosts above, so a call
site is `if (!(await confirm("…"))) return;` and keeps its original shape.
`prompt()` returns **`null` on cancel**, exactly like `window.prompt`: call
sites test for it, and resolving `""` instead would read as a deliberate blank.
Each falls back to the native dialog if its host is not mounted — never to a
value that would let a delete proceed unasked.

---

## Payroll detail

**Pay computation** is per-day, then summed (`payrollEngine.js`):

| Scenario | Rate |
|---|---|
| Ordinary day, regular hours | 100% |
| Ordinary day, OT | 125% |
| Night hours 22:00–06:00 | +10% of the day's **base** rate on every **PAID** minute in the window (see *Night differential* below) — including minutes inside OT, but they are not uplifted by the OT multiplier (that premium is already paid by the OT columns). The holiday multiplier still applies. |
| Regular holiday — unworked / worked / OT | 100% / 200% / 260% |
| Special non-working — unworked / worked / OT | 0% / 130% / 169% |

- **Night differential attaches to PAID minutes only.** The paid stretch is the
  **scheduled duty window plus approved excess overtime, intersected with what
  was actually worked** (`paidStretch()`), and every minute of it inside
  22:00–06:00 earns the premium. Nothing else does.
  - A **night shift or straight duty** earns the window's full overlap, because
    all of it is scheduled duty.
  - A day guard's **early arrival** earns nothing — those minutes draw no base
    pay and no OT, so they draw no premium either. Measured on a ₱570/day
    guard punching in at 05:51 on a 06:00 shift: ₱2.14 over two days.
  - A day guard's **approved overtime** running past 22:00 **does** earn it, so
    this is not "day shifts get nothing".
  - **Unapproved lingering** earns nothing, for the same reason as the early
    arrival: `approvedOtByDate` is what the engine pays, not the minutes
    attendance merely detected.
  - It was computed from the raw **punch interval**, which swept in every unpaid
    minute at both ends. Clamping to the schedule alone would not do either: a
    guard rostered 18:00–06:00 who arrives at 23:30 would be paid the premium
    for 90 minutes before they clocked in — the identical error mirrored. Both
    halves of the intersection are load-bearing.
  - **Unrostered days, degenerate windows** (end at or before start — the
    deliberate equal-times ambiguity) **and broken shifts** keep the previous
    arithmetic; a broken shift's segment boundaries live in
    `attendance-reports.js`, and re-deriving them in the engine would be a
    second implementation of the same thing.
- **A punch belongs to exactly ONE duty, and proximity decides which.** Duties
  each scanned the punch stream through their own window with nothing marking a
  punch as consumed, so two duties whose windows overlap both claimed it. A
  pre-pass in `computeReport()` now allocates each punch to the duty whose own
  schedule is nearest it — an **IN** measured against the scheduled start, an
  **OUT** against the scheduled end. Ties go to the earlier duty, then the lower
  assignment id, so allocation never depends on the order rows came back in.
  - **Proximity ARBITRATES; it does not replace aggregation.** Within a duty the
    row still takes the earliest IN and the latest OUT of the punches it won, so
    a guard who double-punches one duty reads exactly as before. Taking only the
    *nearest* IN and OUT would silently change uncontested days too: an 18:00 and
    a 19:30 OUT on a 06:00–18:00 shift would lose 90 minutes of overtime.
  - **A broken shift's anchors are its segment edges**, so per-segment matching
    still works and the nearest edge decides.
  - **A punch already consumed by a rostered duty is not ALSO an unrostered
    day.** A night shift's closing punch lands on the next calendar date, which
    carries no roster row, so the unrostered pass raised a phantom Present row
    from a punch its own duty had already counted. Suppression is by punch
    identity and is **additive** to the existing date test — it can only remove a
    phantom, never create one.
  - The **out-before-in guard** stays as a backstop. Allocation closes the
    punch-stream path to that state, but an approved correction is bound to the
    **duty date** rather than the punch window, so one filed with the wrong times
    can still supply an OUT preceding the punched IN.
- **Built-in OT** — shift length beyond 8h is auto-recognised (a 12h shift = 8h + 4h), earned by time actually worked past the 8-hour mark. No approval needed.
- **Straight Duty** — a continuous 24-hour tour is NOT one long shift. It is computed as **two consecutive regular shifts** (06:00-18:00 then 18:00-06:00), the same built-in rule applied to each half and the two summed: 4h + 4h = **8h built-in OT**, not the 16h a single 24h shift would give. Base pay follows the same reading (`shiftUnits = 2`, so two day rates): describing the same 24 hours as two shifts in the OT column and one in the pay column would leave eight hours paid by neither. A Straight Duty therefore pays **16h regular + 8h at the OT multiplier** — the full 24 hours accounted for.
  - **Excess OT is measured from the guard's own time-in, not the rostered end.** The tour is twenty-four hours of duty, so starting an hour late means finishing an hour later before any of it is overtime; only what is worked past that 24-hour mark can be excess. Everything *inside* the tour is already recognised as built-in, and counting it twice would put the same minutes in the column that needs approval. This replaced a blanket `overtimeMin = 0`, which was over-broad — the figure it discarded was time worked *after* the tour ended, so a guard genuinely held over was recorded as having done no excess overtime at all. Undertime stays measured against the **rostered** end, as for every other shift.
  - **One record per tour, however the roster entered it.** A 24-hour tour touches two calendar dates and is commonly entered on both. Each entry used to produce its own record, and the second was worse than redundant: its punch window caught the tour's closing punch but no opening one, so it reported the guard **Absent** on a day they had worked — a false absence that fed absence monitoring and the billing LESS deduction. The second entry is recognised as a straight duty for the same guard and post beginning exactly where the previous day's ended, and is suppressed.
  - **A straight duty gets a 6-hour trailing punch window** (the leading edge stays at 2h). With the ordinary 2h pad a tour running even 2h01 over had its closing punch discarded — which cost not just the time-out but the whole 8h of built-in OT, since built-in requires an OUT. That widened tail can no longer steal the PREVIOUS tour's closing punch: the punch sits nearer the previous tour's own scheduled end, so allocation gives it there and the incoming tour holds pending.
- **Broken (split) shift** — one duty day worked in two non-contiguous stretches, e.g. 06:00–12:00 then 00:00–06:00 the next morning. Both ranges live on the **same assignment row** (`startTime2` / `endTime2` / `crossesMidnight2`), so one duty day stays one attendance record and the 8-hour threshold spans the whole duty instead of being tested twice against two short halves that would each earn nothing. The example is 12h of duty, so the eighth hour falls two hours into the second stretch: **02:00–06:00 is built-in OT**, and it sits wholly inside the night window, so night differential applies to it. That is arithmetic, not a special case.
  - **The gap is not worked and must never be paid.** `computeReport()` puts the actual stretches on the row as `workedIntervals`, and `payrollEngine` walks those instead of `timeIn → timeOut`. Read contiguously, the example spans 24 elapsed hours and pays **8h** of night differential where only **6h** were worked, plus 2h of regular time nobody was on duty for. Every other kind of shift has no `workedIntervals` and keeps the original contiguous arithmetic untouched — including its 8-hour mark, which is measured from the *scheduled* start so arriving late does not quietly convert regular hours into overtime.
  - Excess OT is time past the **last** stretch's rostered end; the split itself never creates any.
- **Excess OT** — worked past shift end, beyond a threshold. Requires approval.
- **Statutory** — SSS, PhilHealth and Pag-IBIG each carry **their OWN cutoff**
  (`sssCutoff` / `philhealthCutoff` / `pagibigCutoff` in `pay_rules`), because an
  agency can legitimately remit them on different schedules. Each is `first`
  (the whole month on the 1–15 run), `second` (the whole month on 16–end, the
  seeded default) or `split` (half on each).
  - **There is deliberately no "both cutoffs in full" option.** These are MONTHLY
    obligations, so it would remit double — and on screen it would sit beside
    `split` reading almost identically, the failure mode being every guard's
    statutory silently doubled. An agency whose table is genuinely per-cutoff
    changes the CONTRIBUTION TABLE, not the timing.
  - **`split` uses a remainder, not two independent halves.** Rounding each half
    on its own drifts: PhilHealth at 5% of a ₱19,350 monthly comp is ₱483.75,
    and `round2(483.75/2) × 2` is ₱483.76 — a centavo more than the month owes,
    on a real rate in this agency's own table. The first cutoff takes the
    rounded half and the second takes the remainder, so on an odd centavo the
    **first cutoff carries the extra** (241.88 then 241.87) and the two always
    sum exactly. Both are derived from the monthly total alone, so either cutoff
    can be recomputed on its own.
  - The **employer share follows the employee share's cutoff** — they are two
    halves of one monthly remittance, and splitting them across payslips would
    misstate both.
  - An unrecognised or missing setting resolves to `second`, **never to a half
    share**. The single-setting version this replaced returned 0.5 from its
    fallthrough, so an install missing the key silently split every
    contribution. That is also why the migration maps an ABSENT
    `statutoryCutoff` to `split` rather than to the seeded `second`: split is
    what such an install was actually doing, and a migration must preserve
    behaviour rather than correct it into a silent money move.
  - `statutoryCutoff` is **gone**, dropped once its value was carried across;
    two fields meaning one thing can only ever disagree. The migration is
    guarded by `migration_flags`. The **unguarded** `split` → `second` UPDATE it
    replaced ran on EVERY boot, so once `split` was selectable again an admin
    choosing it would have had it silently reset by the next deploy's restart.
  - Withholding tax is assessed **every** cutoff with half the month's
    contributions in the tax base, so both payslips carry an even tax burden.
    It is unaffected by any of the three settings.
- **Tax** can be switched off company-wide, or per employee (`taxExempt`, for minimum-wage earners under RA 9504).
- **Arrears** — deductions are capped at gross so net can never go negative; the shortfall carries to the next cutoff. Priority: current statutory → voluntary → prior arrears. Balances move **only at Mark Paid**, so recomputing a draft can't double-count.
- **Holidays** — two axes: `type` sets the multiplier, `sites` sets who it applies to (empty = nationwide, populated = a local holiday).
- **Admin overrides are an engine input, not a post-hoc patch.**
  `computeEmployeeLine()` takes an `overrides` map of `fieldName -> value` and
  substitutes the named COMPONENT, after which its own gross → priority/cap
  ladder → net code runs unchanged. An override therefore means *"the engine
  should have ASSESSED X"*, and the ladder re-runs beneath it: a freed peso
  cascades to the next contribution in priority, then to arrears recovery, then
  to net pay, and an over-large override is capped and deferred rather than
  overdrawing the guard.
  - Applying overrides anywhere else means re-deriving the totals outside the
    engine, i.e. a second implementation of that ladder — which is exactly the
    defect in `PATCH /lines/:id` (see *Known Gaps*).
  - **Derived totals are override-LOCKED**: `otPay`, `grossPay`, `netPay`,
    `totalTaken`, `deductionsDeferred`, `arrearsClosing`, `arrearsOpening`,
    `arrearsRecovered`. `netPay` is what disbursement pays, and an overridden
    net would reconcile to nothing against its own itemised payslip. Override
    the components; the totals fall out. An override on a locked or unknown
    field is REPORTED in `overridesRejected`, never silently swallowed.
  - Values are **type-checked, not coerced**: `Number(null)` and `Number([])`
    are both a finite 0, so coercion would accept an absent override as a
    deliberate zero. An explicit 0 is still honoured.
  - **A NEGATIVE override is refused by the ENGINE, not only by the API.** The
    deduction ladder takes `min(amount, remaining)` and decrements `remaining`,
    so a negative INCREASES capacity and manufactures money: measured on a
    ₱926.25 gross, an `otherDeductions` override of −5000 produced a **net of
    ₱5,000 — net exceeding gross** — and with arrears present it also recovered
    them against that phantom capacity. `validateOverride()` already refuses
    negatives, so nothing the API can write reaches it; the second layer belongs
    at the ladder because that is the money path, and it should not depend on
    every future caller having validated first. Rejected and REPORTED in
    `overridesRejected`, never silently swallowed — the same shape as the
    derived-field refusal.
  - `overridesApplied` reports the COMPUTED value each override displaced, so a
    caller can snapshot it and later detect a base that has moved underneath a
    standing override.
  - **Inert until used**: an empty map is byte-identical to no map.
  - **A recompute RECONCILES every standing override.** Each is compared against
    what the engine computed on that run, before the override displaced it. If
    the base has moved the override is marked **stale** — it is still APPLIED,
    never auto-cleared, but it is flagged and **`PATCH /periods/:id/approve`
    refuses with 409** until someone re-confirms, updates or removes it.
    Auto-clearing would silently undo a human decision; silently keeping it
    would let a correction ride a base it was never taken against. The worked
    example is the PhilHealth rate repair: an override taken while the engine
    assessed ₱2.14 must not quietly ride the corrected ₱427.50.
    - If the base RETURNS to the value the override was taken against, the flag
      clears **automatically** — otherwise a period stays permanently
      unapprovable over a divergence that no longer exists — and the clear is
      audited (`payroll_override_reactivated`), so it is automatic but never
      silent.
    - Reconciliation writes sit **inside the same transaction as the line**, so a
      crash mid-run cannot leave a line recomputed against a base its override
      was never checked against. The audit writes stay outside: an audit must
      never fail the action it records.
  - A period holding any override **cannot be deleted** (409, plus
    `ON DELETE RESTRICT` — enforced twice), and removal demands its own reason,
    because afterwards the audit entry is the only place the correction exists.
  - **WHO MAY CORRECT A FIGURE is an explicit allowlist**, not the module
    matrix: `edit` on payroll is grantable per user from Manage Users, so the
    matrix would let someone widen who can move money without touching a
    reviewed line. `PAYROLL_OVERRIDE_ROLES` and `PAYROLL_STATUTORY_OVERRIDE_ROLES`
    are that line — **Admin, Owner / President / General Manager, Accounting /
    Payroll** — separate lists with identical membership today, so a statutory
    override can be gated tighter later without an API change.
  - **A PAID period is locked, and reopening it is a narrower privilege than
    correcting it.** `PAYROLL_REOPEN_ROLES` is **Admin and the Owner only** —
    Accounting / Payroll may correct a line, but may not decide that money the
    disbursement file already paid is back in scope. Reopen takes a typed reason
    of 20+ characters, moves Paid → Approved and stamps `reopenedAt`.
  - **Re-lock is EXPLICIT.** Auto-relocking per edit would demand a fresh reopen
    for every line; relocking on leaving the page depends on an event a closed
    laptop never sends. The cost is a period that can sit open unnoticed, so
    `reopenedAt` is surfaced as a banner on the period screen rather than only
    in the log, and re-lock refuses (409) while any override is still stale.
  - **An edit to a reopened period is audited under its own action name**
    (`*_post_issue`), so a change to disbursed money is never mistaken for an
    ordinary draft correction when the log is read back.
  - **The payslip drops the OT MINUTES when the OT pay was overridden**, printing
    "(adjusted)" instead. OT pay is derived from those minutes, so a corrected
    peso figure no longer reconciles with them — and a payslip stating "240 min"
    beside an amount that is not 240 minutes' pay asserts something untrue to
    the guard holding it. The reason lives in the override and the audit log.
  - **OT HOURS are not overridable, only OT pay.** `builtinOtMinutes` and
    `approvedOtMinutes` are attendance-derived inputs, not components of the pay
    sum; correcting them belongs on the attendance register or in a Missing Time
    Log filing, where the correction also reaches billing.
  - See `OVERRIDE-DESIGN.md`.
- **`payroll_line_days`** records each day's classification and pay so a premium can be explained in a pay dispute.

**Period workflow:** Draft → Computed → Approved → Paid. Paid locks the period.

---

## Duty site detail

The site on a public attendance punch and on a Missing Time Log request is
**picked by the submitter**. It used to be copied from `employees.site`, so it
always agreed with the roster; it is a choice now because a guard on relief duty
works a post that is not their assigned one, and the site is what billing bills.

- **The employee's assigned site is still shown** after Verify, as reference and
  as the pre-selected value. It is not the same field as the picker and must not
  be conflated with it: one is an attribute of the person, the other of the day.
- **Every configured site is offered**, not a subset. Relief duty at another
  client's post is the case this exists for, and no employee→client scope exists
  in the schema to narrow it by. The value is validated against `sites` on the
  server — the list is a convenience, never the check.
- **A disagreement with the roster puts the day on hold, and that matters more
  than it looks.** Punches are matched to roster rows by `guardName|site`, so a
  punch at a site the guard is not rostered at matches NOTHING: the rostered post
  reads Absent and bills its client a **LESS**, while the punch reads as an
  unrostered duty day and bills the OTHER client an **ADD**. One wrong selection
  moves money at two clients in opposite directions, with nothing on screen
  saying so.
- So the comparison is made once at submission (`lib/siteMismatch.js`, pure) and
  **recorded on the row** — `siteMismatch`, `rosteredSite` — rather than
  recomputed later, because the roster can be edited afterwards and the record
  must say what was true when it was filed.
- **Held out of billing on BOTH sides.** `computeReport()` gives the rostered row
  the status **"Pending site review"** (checked BEFORE Absent, so a guard who
  actually worked is never recorded absent) and `billingEngine` skips it, so no
  LESS; `routes/billing.js` filters `siteMismatch IS NOT TRUE` out of its
  unrostered-day query, so no ADD. Excluding only one side would just move the
  error rather than remove it.
- It is **counted, not hidden**: `summary.siteReview` is its own figure beside
  Absent, appended to the report PDF only when non-zero, and Absence Monitoring
  states "Excluded from billing until resolved" in words.
- **`IS NOT TRUE`, never `= false`.** The column is NULL on every row written
  before the site became a choice, and those must keep billing normally.
- **Not rostered at all is NOT a mismatch.** An unrostered duty day is already
  first-class — billing ADDs it as a reliever or extra post — and flagging it
  would hold a legitimate, already-handled case out of billing.
- **A punch's duty date is RESOLVED, never assumed to be its own date.** A punch
  carries an instant; the duty it belongs to is a separate question, and for
  anything crossing midnight the two differ — a night shift's 06:00 time-out
  falls on the FOLLOWING calendar day. The site check used to look the roster up
  by the punch's own PH date, so on a rotation week the 19th's night OUT was
  compared against the 20th's day shift at another post and **falsely flagged**.
  - That false flag was not cosmetic: `computeReport` DROPS a flagged punch from
    the matching index (`continue`), so the duty lost its own time-out and read
    **"No time-out"** while the punch sat plainly in the register. One wrong
    date, two symptoms.
  - `lib/dutyForPunch.js` resolves the punch to the **ONE** duty that owns it,
    by the same rule the allocator uses: an IN measured against the scheduled
    start, an OUT against the scheduled end, nearest wins, ties to the earlier
    duty then the lower id. Candidates are the punch's PH date and the day
    before — bounded to two days, since only a duty starting yesterday can still
    be running.
  - **Checking against BOTH days' posts would be worse than the bug.** On a
    rotation week the guard is legitimately at two posts on consecutive days, so
    a union accepts a punch at either — turning a visible false positive into an
    invisible false negative, and the site is what billing bills.
  - Used by the public punch route and by `PATCH /attendance/:id`. The **Missing
    Time Log** route deliberately does NOT use it: there the guard STATES the
    duty date and there is no punch instant to resolve. A wrong date filed there
    is caught at approval by `noShiftRefusal()`.
- **Resolution is a deliberate act by a named person.** `PATCH
  /absence-monitoring/missing-timelog/:id/resolve-site` re-reads the roster and
  **refuses with 409 while the two still disagree**, so the button cannot make an
  unreconciled day billable: the admin corrects the roster in Shift Scheduling or
  corrects the submission first. Both the flag and its resolution go to
  `audit_log` (`site_mismatch_flagged` / `site_mismatch_resolved`).

## Duplicate punches on the public form

A guard produced **four TIME INs in sixteen minutes** (06:02, 06:09, 06:14,
06:18) — a double-tap on a flaky connection. Two mechanisms, one at each end.

**1. Confirmation before submit** (client). Pressing Submit no longer posts; it
opens a panel naming the **site**, the record type, the guard and the time, with
*Go back* and *Yes, record it*. The site is deliberately the largest element on
the panel — a wrong site is the expensive mistake this form can make, because
the punch then matches no rostered duty and bills a shortfall at one client and
an addition at another. It also carries **more weight than a confirmation
usually would**, because the server rule below is not site-scoped: a wrong-site
punch OCCUPIES its shift's slot until an admin corrects it on the register. This
panel is what keeps one from being submitted. The time **ticks live** — the
server stamps `now()` on insert, so the panel must not look like it is promising
the time it displays.

**2. One TIME IN and one TIME OUT per rostered duty SEGMENT** (server,
`POST /public/attendance`). The rule is **structural, not a stopwatch**.

- **The punch is resolved to the duty that owns it** by `lib/dutyForPunch.js` —
  the same resolution the site-mismatch check and the payroll allocator already
  use — and that duty is **stamped onto the row** (`dutyAssignmentId`,
  `dutySegment`). The question is then "is this shift's slot for this punch type
  free?", answered by one indexed lookup.
- **A second real shift the same day is a different assignment row**, so it is
  allowed with no window to tune and no boundary case. This is the main reason
  to prefer structure over a time window.
- **The SEGMENT is part of the key, and that is load-bearing.** A broken shift is
  ONE assignment row worked in two stretches — 06:00–12:00 then 00:00–06:00 —
  and both clock-ins are legitimate. Keyed on `(duty, type)` alone the constraint
  would refuse a guard's second clock-in for work they are rostered to do.
  `brokenShift()` and `scheduledSegments()` moved out of
  `routes/attendance-reports.js` into `lib/dutyForPunch.js` so the punch route
  and the report cannot disagree about where a segment begins.
- **The race is closed by a REAL UNIQUE INDEX**,
  `uq_attendance_one_per_duty_segment` on
  `("dutyAssignmentId", "dutySegment", "punchType")`. A rolling window cannot be
  expressed as a constraint; this can, so the database refuses the second writer
  rather than the application hoping to have read first. A `23505` is translated
  into the same 409 the read path returns — a guard who pressed twice must not
  see a database error.
- **The migration cannot fail on the existing duplicates**, and by construction
  rather than luck: the columns are NEW, so every row written before it has
  `dutyAssignmentId` NULL, and the index is **partial** —
  `WHERE "dutyAssignmentId" IS NOT NULL AND "deletedAt" IS NULL`. The known
  cluster of four is exempt and stays exactly as it is, which is the agreed
  decision. `deletedAt` is in the predicate so a retired punch stops occupying
  its slot; otherwise retiring a bad punch would leave the guard unable to
  punch again.
- **Deliberately NOT site-scoped.** A second IN for a shift is a duplicate
  whatever site it names, so a wrong-site punch holds the slot until corrected
  on the register. That is the trade that makes the constraint expressible, and
  Mechanism 1 is the defence in front of it.
- **An UNROSTERED punch has no duty to key on**, and unrostered duty days are
  first-class here rather than an error — so without a rule they would be the
  one path still able to produce four time-ins. That path alone keeps a
  **20-minute, site-scoped window** under an advisory lock (no index is possible
  for a rolling window). Twenty comes from the incident: the observed cluster
  spans sixteen minutes from the first punch, and rejection is measured against
  the last ACCEPTED punch, so a 5- or 10-minute window would have kept most of
  the pile.
- **A duplicate is not a failure, and the form must not say it is.** The route
  answers **409 `duplicate_punch`** naming the shift and the recorded PH time,
  and the form renders it on the **success screen** — "Already recorded".
  Showing a red error is what produced four punches: the guard reads "error",
  assumes nothing registered, and taps again.
- **Existing duplicates are left alone**, by decision. Nothing back-fills.

**What the duplicates were doing to billing.** `pairPunches` treats a second IN
while one is open as evidence the first never closed: it **holds the earlier one
and keeps the latest**. So four INs and one OUT billed **06:18–18:00** and
recorded **three held shifts** — and `pendingReviewDays` counts held shifts,
which **refuses Issue with a 409**. Three taps put a client statement into a
state that cannot be issued, pointing the admin at Absence Monitoring where
nothing is missing. Payroll was unaffected: `computeReport` takes the **earliest**
IN. The two engines disagreed, and this makes billing agree with payroll.

**Security.** The endpoint already discloses whether an employee number exists
(404 on unknown); the duplicate message adds *that a shift has been clocked and
when*, behind a valid number plus `PUBLIC_FORM_TOKEN`. Accepted, because a
vaguer message feeds the retry loop this exists to stop. **Denial-of-punch is
accepted knowingly**: anyone who knows a guard's employee number could already
submit a punch as them, and under a structural rule that punch **occupies the
shift's IN or OUT slot** until an admin corrects it — a longer-lived exposure
than the windowed rule's twenty minutes, and not site-limited. Same class,
larger blast radius, documented rather than discovered. Rate limiting is
untouched: the shared 30-per-15-minutes limiter still applies, and a guard who
stops retrying stops consuming the budget a detachment shares.

## Declared relief / coverage

A guard covering another post disagrees with the roster for a legitimate
reason. The public punch form now **refuses a roster-mismatched site outright**
and names the post the roster expects; the guard either fixes the site or ticks
**Relief / Coverage** and resubmits.

- **A THIRD STATE, not a cleared flag.** `attendance_records.reliefDeclared` is
  additive; `siteMismatch` keeps its meaning and stays **true** on a relief
  punch, because the disagreement is real and worth recording. Clearing
  `siteMismatch` instead would return the punch to the ordinary path, where it
  matches no rostered duty and the ROSTERED post reads **Absent** — an absence
  booked against a guard who worked, feeding absence monitoring and
  disciplinary follow-up. That is the failure this column exists to avoid.
- **The checkbox is REVEALED by the refusal, never shown up front.** A box
  sitting on screen from the start invites a guard to tick it to make a warning
  go away, which is the mis-tap this is meant to catch. A typo has no
  declaration behind it and stops at the 400.
- **The rostered site is disclosed only in that refusal**, to a caller who
  already proved a valid employee number and form token.
  `/public/employee-lookup` is unchanged and still says nothing about the
  roster.
- **`computeReport` keeps a declared punch IN the matching index.** An
  undeclared mismatch is still dropped (`continue`) and the day reads *Pending
  site review*; a declared one pairs normally at the site worked, and the
  **rostered** post's own row reads **`On relief at <site>`**. Both facts are
  told: somebody worked here, nobody worked there.
  - Absence monitoring filters `status === "Absent"`, so the relief day is
    excluded automatically rather than by a second rule that could drift.
- **Every counter that classifies a status got a relief bucket**, or the day
  would be counted nowhere and every rate derived from those counters would
  drift with nothing explaining why: `summary.onRelief`, the per-site
  sub-summary, and Executive Summary's weekly counter (matched by **prefix**,
  since the status carries the site).
- **`summary.total` is deliberately NOT redefined.** It means *scheduled* —
  incremented once per rostered assignment, never for an unrostered duty day —
  which is what the report PDF calls it (*"Scheduled: N"*). So the invariant is
  `total = present + absent + onLeave + restDay + siteReview + onRelief −
  unrostered`. Changing that would move the printed figure and every rate built
  on it; recorded here rather than quietly altered.
- **An inline site correction CLEARS the declaration.** The guard declared cover
  at the site they punched; an admin moving the record elsewhere must not carry
  that assertion to a post nobody named. Same reasoning as
  `siteResolvedBy`/`At`, which were already cleared there.
- **Billing is untouched** — it is punch-anchored, so a relief day bills at the
  post actually worked with no special case.
- **`attendance_records` only.** `missing_timelog_requests` deliberately does
  not get the column: that form reports a past day and has no relief concept.

## Per-day site on the roster

The Weekly Roster names the site **inside each day's cell**, from that
assignment's own `shift_assignments.site`. There is no per-guard Site column.

- **A guard does not have one site across a week.** Relief duty and Sunday cover
  are ordinary, and the site is what billing bills — so a roster stating one
  site per guard is stating something untrue about most weeks.
- **It replaced a column that looked authoritative and was not.** That column
  was not the 201 File's site, as it appeared to be: the row object took `site`
  from the FIRST assignment the grid encountered, and `GET /assignments` orders
  by `dutyDate, site, startTime` — so it showed **the guard's earliest-dated
  shift that week**. A Sunday relief at another post was invisible while the
  column still read as a fact about the person.
- **What the cell shows is the column the system checks.** `computeReport`
  matches punches to rostered duties on `guardName|site` using this same
  `shift_assignments.site`, and the site-mismatch hold derives from it. The
  roster, the Attendance Register and the billing hold now agree on screen
  because they read one value — which is the point: the held-for-review reports
  were confusing largely because the roster displayed a different site from the
  one being compared.
- **This was display-only.** `shift_assignments.site` has stored a per-day site
  since the table existed, every writer already accepts one, and the Assign
  Shift dialog has always carried a site picker. No migration, no route change,
  no change to the assign flow.
- **`site` is `TEXT` and nullable.** An assignment carrying none can never match
  a punch, so the cell says **"No site"** rather than rendering an empty line —
  a data gap that silently produces an unrostered day is worth naming.
- **Sorting by site went with the column.** It sorted guards by whichever day
  happened to be first, which is not a property of a guard.
- **The empty cell's Assign prefill is the guard's 201 File site.** It used to be
  the collapsed row value, so assigning a Sunday relief proposed the wrong post.
  A starting value only; every site stays selectable. The modal's own
  `onGuardChange` auto-fill cannot supply it here, because that fires only when
  the guard dropdown CHANGES and this opens with the guard already chosen.
- **Rest days carry no shift and so no site in the cell**, and **Copy last week
  carries each day's stored site across** — it copies the assignment rows,
  `site` included.

## The per-guard timesheet

*View Attendance Record* on the register opens one guard's daily time record for
one payroll period. **Read-only** — there is no input, no writable control and no
write verb on the route. Corrections happen on the register, where the
issued-period freeze and the site-mismatch hold live; a timesheet that could
edit would be a second, unguarded path to the same data.

- **Everything per-day comes from `computeReport`** — status, late, undertime,
  and BOTH overtime figures — so it cannot disagree with the register, the
  reports or payroll about the same day. Nothing is recomputed.
  - `builtinOtMin` — overtime inherent to the SCHEDULED shift beyond 8h (a 12h
    shift earns 240; a straight duty earns 480).
  - `overtimeMin` — **excess** OT, derived from the actual punch-out against the
    scheduled end, past `otThreshold`. Shown in its own column; the two are
    never summed on screen. A 06:00–18:00 shift punched out at 20:00 reads
    **240 built-in and 120 excess**.
- **Payroll periods are DERIVED**, not stored: the 1st–15th and 16th–end of each
  month, matching `periodsPerMonth = 2`. `payroll_periods` rows exist for the
  payroll module but are deliberately not consulted, so a period is always
  available to look at even before payroll has been set up for it.
- **The Site in the header is the guard's MOST ROSTERED site for that period**,
  counted over rostered days only and tie-broken alphabetically so the same
  guard and period always render the same value. It is period-relative on
  purpose — a guard who moved posts mid-month reads differently for 1–15 than
  for 16–31. Derived from the roster rows already loaded, never a stored
  "assigned site" column. With no roster at all it reads *No rostered site*.
- **One line per date**, including dates the roster never touched — the paper
  form has a line for every day and a gap reads as a rendering fault. Rest days
  and unrostered dates show blank shift times; the Status column carries why.
- **Bounded**: seven SQL statements for the whole period, measured identical for
  a 15-day and a 90-day range — five from the engine plus the employee record
  and the period's Missing Time Log filings. Nothing runs per day.
- **Columns deliberately OMITTED** because CSOMS does not track them: ATRO,
  Change Sched/Restday, Official Business. **Night differential and the
  holiday Regular/Special split are omitted for a different reason** — they
  exist, but in `payrollEngine`, since they need a pay rate. Surfacing them here
  would mean running payroll computation inside a read-only view; they belong to
  the payslip, which already prints them from `payroll_line_days`.
- **Read access only**: `GET /attendance-reports/timesheet` is gated by the
  attendance module's `view`, like every other read there. Deliberately broader
  than `ATTENDANCE_EDIT_ROLES` — that allowlist exists because editing moves
  money between clients, and reading moves nothing.

## Retiring a punch

Deleting an attendance punch is a **soft delete**: `attendance_records.deletedAt`
is stamped and the row stays. `DELETE /attendance/:id` retires,
`PATCH /attendance/:id/restore` puts it back, `GET /attendance/_all/deleted`
lists what is retired.

- **A punch is evidence and it drives a client's bill.** Removing the row
  outright made a mistaken deletion unrecoverable, and left Live Feed with
  nothing to show but the fact that something had gone. Retiring it keeps the
  row, its selfie and its coordinates.
- **NULL means live, and EVERY read filters on it** — `computeReport` (so
  attendance, payroll, the timesheet and absence monitoring), the register list,
  all three register stat cards, and **billing's compute query**. A retired
  punch reaches no report, no payslip and no statement. The filter is the
  predicate of a partial index, `idx_attendance_live`.
- **A retired punch cannot be EDITED** — `PATCH /attendance/:id` refuses with
  **409 `record_deleted`**. Otherwise an edit would change a record nothing
  reads, taking effect only if somebody later restored it.
- **The audit carries a full PRE-DELETE snapshot**, written before the row is
  touched: guard, employee number, site, punch type and PH time, the rostered
  **duty** the punch belonged to (resolved by `dutyForPunch`), the counterpart
  punch and the **hours the pair made**, the affected billing periods, and the
  acting user's id, username and role label — plus the machine-readable object.
  "Record 412 deleted" cannot tell anyone whether a deletion was right.
- **The privilege is UNCHANGED**: `perm.delete`, granted per user from Manage
  Users. Restore and the retired list are gated on the SAME privilege, resolved
  explicitly by `hasAttendanceDelete()` rather than read off `req.moduleGrant` —
  `modulePermission()` derives the action from the METHOD, so a `PATCH` would
  ask about `edit` and a `GET` about `view`, neither of which is what these mean.
- **Neither new route uses `requireRole()`.** `restore` is in the `WORKFLOW`
  pattern, so `modulePermission` withholds `moduleGrant` there by design and a
  bare `requireRole()` refuses everyone but Admin. That exemption exists so a
  workflow step keeps the ROUTE's own check decisive — and
  `hasAttendanceDelete()` is that check.
- **Nothing is repriced by either action.** Billing reads punches live at
  compute time, so hours leave or return to a statement on the next recompute of
  the DRAFT period; both responses name the affected periods.

> **Known gap: the correction-undo path still hard-deletes.** Rejecting an
> approved Missing Time Log request removes the punches that approval wrote
> (`absence-monitoring.js`), and those are still `DELETE`d outright. They are
> rows the system itself created inside its own workflow, and the reject flow
> reports `punchesRemoved`, so the action is visible — but it is not reversible
> the way a register delete now is.

## Correcting a punch's site or record type

Guards choose both the **site** and the **record type** on the public attendance
form, and both are sometimes wrong — a relief guard picks their home post, or
taps Time In meaning Time Out. Correcting them BEFORE the period is billed is
the normal path: an inline edit on the Attendance Register, then recompute.
`PATCH /attendance/:id` takes `site` and/or `punchType`; absent means unchanged.

- **Record type is IN or OUT, and nothing else.** There is no `BOTH` punch —
  `BOTH` is a `missingType` on a *Missing Time Log request*, meaning both
  punches are missing. One row is one punch.
- **A record inside an ISSUED or PAID period cannot be edited, and there is no
  reopen-to-edit path.** A statement that has gone to a client is immutable
  in-system; a dispute is settled outside CSOMS. Refused with **409
  `period_frozen`** at the API, because a stale tab or a direct request must not
  get through. **Both sides of a move are checked** — the site the punch leaves
  and the site it arrives at — since a cross-client correction lands on two
  statements and refusing only one would move the hours anyway.
- **The site-mismatch hold is re-evaluated, never suppressed.** The corrected
  site is compared against the roster for that punch's own PH date, exactly as
  the public form compares at submission, and `siteMismatch` / `rosteredSite`
  are restamped. If they now disagree the day is held for review; the admin
  clears it by making the **roster** agree, not by the system dropping the flag.
  A previous `siteResolvedBy`/`At` described the OLD site, so it is cleared
  rather than carried across.
- **An incomplete day stays incomplete.** Editing the site of a punch whose
  time-out is missing corrects the site and nothing else — the day keeps its
  "No time-out" hold until the OUT exists.
- **Nothing is repriced by the edit.** Billing reads punches live at compute
  time, so a correction reaches a statement only when the DRAFT period is
  recomputed. The response returns `affectedPeriods` and the register says so in
  words, matching the billing screen's own "not reflected until you recompute".
- **DELETE is a separate privilege from this edit, and is granted per user.**
  The register's actions column offers **Edit** to the allowlist and **Delete**
  to `perm.delete` — "Admin, or the matrix grants it", which is exactly what
  `DELETE /attendance/:id` enforces. Gating the whole column on the allowlist
  cut both ways: an **Owner** holding delete saw no actions column at all, while
  an Operations user **without** the grant was shown a Delete button that 403s.
- **The register's guard dropdown is served by the ATTENDANCE module**
  (`GET /attendance/_all/guards`), not by `/leave/employees`. It used to read the
  Leave route, so a user holding attendance but not Leave Management got the page
  with an EMPTY guard filter and no way to scope it to one person — measured at
  attendance 200, guard list 403. A screen must not need a second module's
  permission to fill its own filter. Returns id, full name and employee number
  only; no pay, no HR fields.
- **Gated by an EXPLICIT ROLE ALLOWLIST**, `ATTENDANCE_EDIT_ROLES` in
  `permissions.js`: **System Administrator (`Admin`)** and the **Operations role
  (`Operation Manager / Operation Officer / Supervisor`)**, and nobody else.
  - **Not the Add/Edit/Delete matrix.** `modulePermission()` maps PATCH to
    `edit`, and four roles hold edit on attendance that must not have this.
    Measured across all nine roles: `Admin` TRUE, the Operations role TRUE, and
    **Owner, HR, Accounting / Payroll, Security Admin Officer, Inspector /
    Investigator, Investigator and Viewer all FALSE**.
  - **Not `delete` either.** That is a matrix cell a per-user override can grant
    from Manage Users; widening who may move money between clients has to mean
    editing this list, where it is visible in review. Verified: an HR user given
    **full** access on attendance still holds no allowlist seat.
  - Mirrored for the UI in `frontend/src/roles.js`, which cannot import from
    `src/` — that copy only decides whether to draw the button.
  - **PENDING GRANT — Owner to be added to the attendance-edit allowlist**,
    deliberately, alongside its other pending access (Executive Summary and Live
    Feed). Note the role already exists and is assignable today, so this is an
    exclusion in force, not a placeholder waiting on a role to be created.
- **Audited**, because it moves money: `attendance_record_site_changed` /
  `_type_changed` to the same `audit_log` the Live Feed reads, carrying the old
  value beside the new one, the mismatch it caused, and the affected periods.
  The audit write swallows its own errors — it must never fail the action it
  records.
- **Re-pairing is left to the existing machinery.** A flipped record changes what
  the proximity matcher and `deriveSiteDayHours` receive, and both re-derive from
  scratch; an impossible result (an OUT with no IN, or an OUT before its IN) is
  held by the ordering guard rather than booked as negative time. The route does
  not second-guess the admin.

> **Known gap: a punch's site-mismatch flag has no resolve action.** The
> `resolve-site` route works on `missing_timelog_requests` only, and
> `attendance_records.siteResolvedBy`/`siteResolvedAt` are written by nothing
> but the edit above. Correcting the roster does not clear a punch's stored
> flag, so the day keeps reading "Pending site review" until the record is
> edited again. It misleads rather than blocks — billing ignores `siteMismatch`
> entirely under the punch-anchored model, and `pendingReviewDays` counts
> incomplete pairs, not mismatches — but the flow is incomplete.

## Approving a correction

An approved Missing Time Log request WRITES attendance punches, so the times it
is approved with have to come from the guard's **rostered shift** — the review
form pre-fills them from it, and a night shift's time-out lands on the following
calendar date, which a single blanket time pair could not express.

- **Approval is REFUSED when the duty date has no rostered shift**, on both the
  single (`409`) and the bulk route (skipped and reported). The form used to fall
  back to **06:00–18:00** when nothing was scheduled, and for a **straight duty**
  that is not a harmless default: the tour is a continuous 24 hours paid as 16h
  regular + 8h built-in OT, so writing it as a 12-hour day books twelve hours of
  undertime, discards four hours of built-in OT and all eight hours of night
  differential. Measured on a ₱645/day guard: **₱2,160.75 correct against
  ₱725.63 — ₱1,435.12 underpaid on one duty day.**
- **That refusal tells TWO causes apart, because they need opposite
  instructions** (`noShiftRefusal()`, shared by both routes so a reviewer cannot
  be given contradictory advice depending on which button they used):
  - `no_roster_shift` — the shift really is gone. *Recreate it in Shift
    Scheduling.*
  - `wrong_date_prev_day_crosses` — the **previous day** carries a shift for this
    guard that crosses midnight, so it ENDS on the date filed. The guard reported
    the date their shift ended rather than the date it started, which is the
    ordinary mistake on a night shift or a straight duty because the missing
    time-out falls on the following date. The reply names the date to re-file
    against and **explicitly warns against adding a shift on the filed date**.
  - Telling the second case to "recreate the shift" is what the first release of
    this refusal did, and it is actively harmful: the admin would add a SECOND
    roster row on a date nobody was scheduled, which then reads as a **false
    Absent day** feeding absence monitoring and disciplinary follow-up against a
    guard who worked exactly as rostered. It would not reach a client statement —
    billing is punch-anchored and never consults the roster — but a fabricated
    duty day is still a fabrication.
  - Dates in these messages are formatted **from the `YYYY-MM-DD` string, never
    through a `Date`** (`prettyDate()`). Every timezone defect in this system has
    come from parsing a date into an instant and reading it back elsewhere, and
    there is nothing here that needs converting.
- **The refusal lives on the SERVER, not on the button.** The bulk route always
  skipped these; the single route never looked at the roster at all and wrote
  whatever times the body carried. A disabled control is not a check — a stale
  tab, a retry or a direct API call reaches the route regardless — so the single
  route now carries the same `LEFT JOIN LATERAL` the bulk route uses and refuses
  there. The form's fallback is deleted, its time fields render **empty and
  disabled**, and Approve is gated; those are conveniences on top of the check.
- **Rejection stays allowed with no rostered shift**, and still undoes any
  punches an earlier approval wrote. A request whose roster entry was later
  deleted is exactly the kind that should be rejectable, so the guard is placed
  in front of approval only.
- **The refusal is shown BESIDE the button**, like the *Resolve site* refusal —
  `reviewMissing()` returns `{ ok, error }` rather than raising into a
  page-level banner the reviewer would never see, and the modal stays open so
  the times already typed are not thrown away.

**Selfie and attachments on the Missing Time Log form** are **optional**, unlike
the attendance punch where the selfie IS the evidence. This form reports a PAST
day, often from home days later, so a photo taken now proves who is filing rather
than that they were on post — and requiring a camera would lock out the guard
whose phone failure is the thing being reported. A denied location shows a retry
link and blocks nothing. `public/selfie-capture.js` is shared by both forms
rather than copied, so one stamping routine serves both; the stamp is drawn INTO
the pixels, since EXIF does not survive a screenshot. Uploads are checked by
**magic bytes** (`lib/fileSniff.js`) as well as declared MIME, and a disagreement
between the two is refused. Downloads are `requireAuth` and always
`Content-Disposition: attachment` with `nosniff`, serving the sniffed type —
never inline, because rendering attacker-supplied bytes inside an authenticated
admin session is what would turn opaque storage into a live risk. Nothing is
virus-scanned; see Known Gaps.

---

## Billing detail

**Billing is anchored to the PUNCH; payroll is anchored to the ROSTER. They are
allowed to disagree.** Billing used to read the same `computeReport()` payroll
reads, and this file used to state that the two "can never disagree about who
was on post". **That invariant is retired.** The client contracts a *post*, not a
person, so what they are owed is measured by the man-hours actually worked at
that site — the schedule is not consulted at all. Payroll still pays a guard
against their roster. The two now answer different questions.

What follows from it, all intended:

- a **relief guard's hours count at the site they punched**, with no reconciling;
- a **rest day nobody covered is a genuine shortfall**, where the old model
  exempted rest days from a LESS entirely;
- **leave, absence and roster edits have no direct effect** — only hours do;
- the roster is still the operational plan, and roster/attendance disagreements
  are reconciled upstream in Shift Scheduling and Attendance, not here.

### The site-level man-hour model

**The baseline is FLAT and covers a fixed number of days.**
`billingPeriodRate = (contractRate ÷ periodsPerMonth) × contractedGuards` buys
`billing_config.standardPeriodDays` (15) days of full daily duty. It does not
move with the calendar — so the period's real length has to be reckoned with
explicitly, or a 16-day August and a 13-day February bill the same flat figure.
That was the defect in the first release of this model: the requirement was
summed over the period's ACTUAL days, so any fully served period netted to zero
however long it was, giving away the 31st and over-charging February.

The period therefore splits in two (`deriveSiteDayHours` in `billingEngine.js`):

**Days the baseline covers** — the first `standardPeriodDays` of the period:

```
actual   = Σ over COMPLETED IN/OUT pairs of MIN(shiftDuration, standardShiftHours)
required = contractedGuards × standardShiftHours
net      = actual − required     →  >0 ADD | <0 LESS | 0 nothing
```

**Days beyond it** — the 16th day of a 16-day period: whatever was worked is an
**augmentation (ADD)**, and nothing worked is worth **nothing in either
direction**. An extra day carries no requirement, so it can never take a LESS —
you cannot credit somebody for a day they never bought. Applying the ordinary
per-day rule to those days and then adding a flat calendar augmentation nets to
the same figure but grosses the statement up absurdly: an entirely unmanned
16-day post read *"LESS 16 days"* **and** *"ADDITIONAL 1 day"*, billing an
augmentation for a day nobody worked, with both landing on the same date.

**Days the standard has that the calendar does not** — a 13-day February is
short of the 15-day standard by the 29th and the 30th. The client paid for them,
so they are credited in full: `missingDays × contractedGuards × standardShiftHours`
as a LESS, printed as *"No calendar date: Feb 29-30 2026"*.

The algebra closes: `addHours − lessHours` always equals
`actualHours − (standardPeriodDays × guards × standardShiftHours)`, and the unit
suite asserts it on every shape.

- **One signed figure per site-day.** A day is short or over, never both — the
  old model accumulated LESS and ADD *independently* and routinely produced both
  on one day (an absent guard crediting a shift while a reliever charged for
  one). That two-step is what this replaced. A **period** can still carry both
  totals, summed from different days; that is correct, not a leak — a short
  February crediting two non-existent days while the 22nd was over-manned is
  exactly the agency's own statement.
  - The **one exception** is the missing-days credit, which describes the PERIOD
    rather than a date. `billing_line_days.dutyDate` is `NOT NULL` and Feb 29
    does not exist, so it is parked on the last real day of the period and its
    reason begins `No calendar date:`. It is the only row that may share a date
    with another figure; every row that describes its own day still cannot.
- **The SOA's "N Days" is GUARD-days, not calendar days.** `hoursAsDays()`
  divides by the post's standard shift, so 72 h at a 12 h post prints as
  "6 Days, 72 Hours" — six guard-shifts not rendered, which is what the
  client is being credited for. The divisor is the DETACHMENT's `dutyHours`
  (snapshotted onto the line as `dutyHoursUsed`); `billing_config.defaultDutyHours`
  only supplies one to a detachment that set none.
- **The statement's wording is derived, and a typed remark overrides it.**
  `derivedRemarkLess` / `derivedRemarkAdd` are refreshed on every recompute and
  printed when `remarksLess` / `remarksAdd` are blank, giving
  *"No calendar date: Feb 29-30 2026 - LESS: 6 Days, 72 Hours"* and
  *"Jul 31 2026 - AUGMENTATION: 3 Days, 36 Hours"* with nobody typing anything.
  The remark is the DATES ALONE — the row supplies the word — so a remark ending
  in "Augmentation" would print it twice. The typed remark is deliberately NOT refreshed by recompute:
  a recompute must never rewrite a human's sentence on a document that goes to a
  client.
- **`standardShiftHours` IS `billing_sites.dutyHours`** — the field already
  existed, already defaults to 12 through `billing_config`, and is already
  admin-editable on Clients & Detachments. No second column: two fields meaning
  one thing can only ever disagree.
- **Two caps, both measured in WHOLE SHIFTS.** `shiftUnits()` infers how many
  shifts a punch pair covers from its DURATION alone:
  `clamp(round(duration ÷ dutyHours), 1, 2)`.
  - A pair counts at most `units × dutyHours`, so 05:44–18:01 is 12 h and not
    12 h 17 m, while a **straight duty** — one continuous ~24 h pair — counts the
    full 24. It was a flat `dutyHours`, which flattened a genuine 24-hour tour to
    12 and silently swallowed the augmentation the client owed: the real Aug-16
    Brookdale day computed 36 h against a 36 h requirement and billed **no
    augmentation at all**, when three guards had delivered 48 man-hours.
  - A guard contributes at most **their longest pair's** units × `dutyHours` per
    site per day. So two SEPARATE 12 h pairs still cap at 12 — a broken shift is
    one duty split in two, not two duties — while one continuous 24 h pair passes
    through whole. Same total hours, different shape, different answer.
  - **The boundary is the midpoint**, 1.5 × `dutyHours`. Below it a pair reads as
    one shift with overrun; at or above it, as a two-shift tour that may have
    ended early. Any threshold has a discontinuity; the midpoint puts it where
    pairs are rarest and holds the jump to half a shift.
  - **Inferred from the punch, never the roster.** `computeReport` does tag a
    straight duty, but only in the roster-anchored view billing deliberately
    stopped reading — and the very day this fixes carries an UNROSTERED punch, so
    a roster-derived rule would have had nothing to read for it.
  - **A pair that would round to three or more shifts is billed at the two-shift
    cap AND held**, because nobody works three consecutive tours: it is a missing
    time-out, not coverage. Silently clamping would bury the data error inside a
    plausible figure. `MAX_SHIFT_UNITS` is 2; raising it for an 8 h-shift site
    with triple duties is one number.
  - **Headcount is never billed or penalised** — only man-hours are. One day
    shift plus one straight duty is 36 h on a 3×12 post: two bodies, requirement
    met, no adjustment either way.
- **Required applies to EVERY calendar day** in the period. No weekly or holiday
  exception is modelled.
- **Pairing walks a continuous per-`(guard, site)` punch stream**, and each
  completed pair is attributed to the PH date of its **IN** punch. Bucketing by
  day *first* is the obvious implementation and it is wrong: an 18:00→06:00
  shift would leave an IN with no OUT on one day and an OUT with no IN on the
  next, corrupting both. The punch query therefore reads **one day past
  `periodEnd`** so a shift starting on the last day can still be closed; a pair
  whose IN falls outside the period is dropped.
- **An OUT with no preceding IN is ignored and logged** — it cannot be priced,
  but it means a punch went missing and somebody has to know.
- **There is no `siteMismatch` filter.** It excluded punches whose site
  disagreed with the roster; the punch's site is authoritative now, so a
  "mismatch" is simply a relief guard and those hours are real. Keeping the
  filter would delete genuine man-hours and manufacture a shortfall.
- **An unmapped site is reported, never swallowed.** With no roster fallback
  left, attendance at a site no `billing_sites` row claims is man-hours that can
  reach no statement at all. `POST /periods/:id/compute` returns
  `unmappedSites` and the period screen names them.

Then, per detachment, per period (`computeSiteBilling`, reproducing the agency's
"Billing Auto Compute Template"):

```
manHourRate       = contractRate / 365            ← unusual; see Known Gaps
billingPeriodRate = (contractRate / periodsPerMonth) × guards   ← per-client cadence
billingCost       = (billingPeriodRate + addAmount) − lessAmount
                    + legalHolidayAmount + specialHolidayAmount
adminFee          = billingCost × 12.24%          ← per-client overridable
dueForGuard       = billingCost − adminFee
withholdingTax    = adminFee × 2%                 ← OF THE FEE; per-client overridable
netAmount         = billingCost − withholdingTax     ← "Please pay this amount"
```

- **Derived adjustments** are the netted site-day figures above: LESS = the
  man-hours the client contracted and did not receive, ADD = man-hours delivered
  beyond the contract. There is no longer a per-guard Absent / Late / Undertime /
  excess-OT breakdown — all of it is subsumed by "hours on the post".
- **Overrides.** Each quantity is stored three ways — `derived*` (refreshed
  every recompute), `*Override` (never touched by recompute), and the plain
  effective column, `override ?? derived`. Pressing Recompute therefore cannot
  discard a deliberate edit, and clearing an override restores the attendance
  figure.
- **Billing cadence is per client.** `billing_clients.billingCadence` is
  `semi_monthly` or `monthly`, and **both** operands are derived from it by
  `resolveCadence()` — `periodsPerMonth` (which divides the contract rate into
  the baseline) and `standardPeriodDays` (which the baseline covers). NULL means
  the agency-wide pair in `billing_config`, so every existing client resolves to
  2 × 15 and computes byte-identically.
  - **They are ONE choice because they are one fact**, and setting them apart is
    expensive and invisible: a monthly client (`periodsPerMonth` 1) left on a
    15-day standard bills a fully served 31-day July at **₱160,232.87 against a
    correct ₱108,452.05** — a 48% over-bill that reads on the statement as an
    ordinary 48-guard-day augmentation. Measured, not theorised.
  - `CADENCES` is **code, not a configurable list**: each entry carries
    arithmetic, so adding one necessarily means writing its operands. A Manage
    Lists entry would let somebody add "Weekly" with nothing behind it.
  - **Monthly is a flat 30**, matching the flat 15 semi-monthly uses. It carries
    the same ÷365 reconciliation gap, doubled (₱479.60 against ₱239.80) because
    it is a whole month rather than half — see Known Gap 6. 365/12 = 30.4167
    would close it but prints fractional-day adjustments on a client statement.
  - **Cadence lives on the CLIENT, never the site.** A `billing_period` has one
    `clientId` and one date range covering all that client's detachments, so two
    detachments under one client physically cannot have different period lengths.
  - The **operands** are snapshotted onto the line (`periodsPerMonthUsed`,
    `standardPeriodDaysUsed`), not the cadence name: re-deriving through
    `CADENCES` at read time would silently restate an issued statement if that
    map ever changed.
  - **The agency-wide pair is still two free numbers**, and that is the one place
    they can disagree. `PUT /billing/config` refuses a pair whose product is not
    28–31 days. Replacing that pair with a global default *cadence* is the tidier
    end-state and is deliberately deferred.
  - **Nothing forces a period's dates to match the cadence.** A monthly client
    given a half-month period credits the 15 unbilled days as "no calendar date"
    and halves the invoice. The New Period modal WARNS when the span diverges by
    more than a day; it does not block, because a mid-month onboarding or a
    mid-cycle termination is a real part-period.
- **Holiday pay is two manual peso figures per line**, `legalHolidayAmount` and
  `specialHolidayAmount`, typed on the Adjust modal — nothing derives them,
  because whether a client is charged for a holiday and at what premium is
  settled off-system. They fold into **`billingCost`**, beside the augmentation
  and the LESS, which is what makes them taxed: the admin fee and the
  withholding are taken from the resulting figure. **The fee layer is unchanged
  — withholding stays 2% OF THE ADMIN FEE**, not of the billing cost, which is
  what the agency's own statements show.
  - `NOT NULL DEFAULT 0`, so a line with no holiday pay is arithmetically and
    visually identical to one from before the columns existed.
  - The SOA prints *"Legal Holiday Pay"* / *"Special Holiday Pay"* **only when
    the amount is non-zero**, on the same `if (> 0) row(...)` rule the
    adjustments use — `row()` advances the cursor only when called, so an absent
    line occupies no space.
  - **No `*Used` snapshot column is needed.** `contractRateUsed` and friends
    exist because those values come from CONFIG, which can change under an
    issued statement; a hand-typed amount IS its own snapshot. Recompute's
    `ON CONFLICT` refresh list carries no manual column, and `PATCH /lines/:id`
    refuses a non-Draft period — so the figure survives reopening and
    recomputing untouched.
- **Manual ADD is ADDITIVE, and is the one exception to that shape.**
  `addHours = (addHoursOverride ?? derivedAddHours) + addHoursManual`. Netting a
  site-day into a single figure leaves no derived line for genuine billable
  overtime the client agreed to pay, so it is entered by hand on the Adjust
  modal and **added on top** rather than replacing anything. An *override* says
  "ignore what was derived"; manual ADD says "and also charge this". Both can be
  set at once. `NOT NULL DEFAULT 0`, so a cleared field means "nothing extra"
  rather than "unset".
- **`billing_line_days`** records every day behind a derived figure, so a
  disputed statement can be answered day by day.
- **Guard count** comes from the contract (`contractedGuards`), not attendance:
  two guards alternating one post is still one billed post, and it is what
  `requiredHours` multiplies. `derivedGuards` now counts the distinct guards who
  actually worked a completed shift there — no longer a roster figure — and sits
  beside the contracted count so a divergence stays visible.
- **An incomplete IN/OUT pair counts ZERO man-hours and HOLDS the day.** (An
  over-long pair also holds it, but is billed at the cap — see the two caps
  above. Both mean a punch needs looking at; they differ in what they bill.)
  - **A held shift therefore CREATES a LESS.** This is a deliberate reversal of
    the previous behaviour, where a held day was neutral and contributed to
    neither total. Hours nobody can evidence are hours the client did not
    receive, so they are credited — and the correction is what earns them back.
  - **A hold is independent of the day's sign.** A held shift can only lower
    `actual`; a surplus never cancels it. A day can legitimately read **ADD** and
    still be held.
  - **A confirmed unmanned day is not held.** Zero completed pairs and nothing
    incomplete is a full `requiredHours` LESS, stated with confidence.
  - **It resolves itself, so there is no separate "resolve" action.** Approving a
    Missing Time Log request supplies the OUT; the next recompute counts those
    hours and shrinks the shortfall. `pendingReviewDays` is refreshed like any
    derived figure rather than being a flag someone clears.
  - **Counted, never dropped.** `billing_lines.pendingReviewDays` holds the
    count and each held shift goes to `billing_line_days` with `kind = 'pending'`
    and `hours = 0`, its reason naming the time-in.
  - **Issue is refused (409) while any line holds one**, naming the detachments
    and pointing at Absence Monitoring; the button is disabled with the same
    reason. A statement is a demand for payment, and issuing freezes it.
- **Two fee percentages can be set per client**, `billing_clients.adminFeePercent`
  and `withholdingTaxPercent`, both nullable — `resolveFeeConfig()`, the same
  `override ?? global` shape every quantity uses. **NULL means the agency-wide
  figure in `billing_config`**, which is what every client does until someone
  types a value, so existing clients compute unchanged. Unlike `contractRate` a
  stored **0 is honoured**: a client billed no withholding tax is a real term, a
  client on a free contract is not. A value outside 0–1 is refused at the API —
  entering `12.24` instead of `0.1224` would bill 1224%. **Nothing else in
  `billing_config` is per-client**: the man-hour divisor, periods per month, SOA
  prefix and the default rate and duty hours stay global by decision.
  - The **applied** percentages are snapshotted onto the line
    (`adminFeePercentUsed` / `withholdingTaxPercentUsed`) beside
    `contractRateUsed`, because the SOA prints the rate in words — "Less: 2%
    Withholding Tax" was hardcoded, and a statement must state what it charged,
    not whatever config holds when it is reprinted. The register's column header
    and the on-screen one dropped their literal "2%" for the same reason.
  - `PATCH /billing/clients/:id` uses the `has()` pattern for these two —
    absent means unchanged, present means set (possibly to null) — so a request
    sending only `{ active: false }` cannot silently reset a negotiated
    percentage. `contractRate` keeps its existing unconditional assignment.
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

## Duty Detail Order detail

A DDO is the document required by **RA 10591** and **Rule 39 §154-156 of RA
11917** authorising a named guard to bear a named firearm at a named post. A
PNP inspector can demand it at the gate, so it is a legal instrument — not an
internal note — and the module is built accordingly.

- **Guards come from the 201 File, firearms from the Asset register.** Issue is
  refused when a line names a separated guard or a Retired/Lost firearm.
- **"MAKE CALIBER" is the asset's brand and ITEM NAME joined** — "Armscor" +
  "9MM Caliber" — because that column names the make and the calibre. The
  model ("STK100") is a product code, belongs on the asset record, and does
  not go on a PNP form. Falls back to the asset's `caliber`, then `model`,
  when brand and name are both empty.
- A line captured under an earlier rule keeps the value it was given, since an
  edit must never be silently overwritten. **Use register values** in the line
  editor refills all three particulars from the asset on demand.
- **The Operation Head signs it**, read from System Settings at Issue and
  snapshotted onto the order. Admin Officer and Operation Head are configured
  separately there; nothing is hardcoded into the report.
- **The firearm particulars stay editable on the line.** The register is not
  always complete — a licence expiry may never have been recorded against the
  asset — and the order still has to print the correct date. Picking a
  *different* firearm refreshes all three from that asset, so a swap cannot
  leave the previous weapon's serial behind.
- **Amend returns an issued order to Draft keeping its number**, and re-issuing
  keeps that same number. A DDO with a wrong serial is corrected and reissued
  as the same order; cancel-and-renumber would leave holes in the post's series
  and a guard holding a number that no longer exists.
- **The number series runs per post**: `YYYY-MM-NNN`, counted within that post
  and month. Two posts both legitimately hold `2026-08-001`; a re-issue at one
  post in the same month becomes `-002`. Uniqueness is therefore on
  `(site, ddoNo)`, never on `ddoNo` alone.
- **Everything printed is snapshotted at Issue** — form version, references,
  instructions, signatory. Editing the boilerplate later must never rewrite an
  order already in a guard's possession. A *draft* previews the live wording,
  so what you check before issuing is what gets frozen.
- **Expired is derived on read**, never stored: validity is a fact about today,
  and a silently stale order is the failure this document exists to prevent.
- **Conflicts block issue**: the same firearm on two lines, the same guard
  twice, or a firearm already live on another post's order. The source
  workbook carries exactly this defect — serial `RIA2950961` appears on both
  the HAT and SALUYOT sheets.
- **Unarmed lines are normal.** Several posts on the source form carry a name,
  designation, place and shift with no firearm.
- `from-roster` builds the duty table from `shift_assignments` — the same
  roster attendance and billing read — one line per guard and shift pattern,
  not one per day.
- The boilerplate is seeded **verbatim** from the agency's "Revised Form No.
  2025", including its own spelling. It is their legal wording; correcting it
  silently would change a document they issue. Editable from the tab's *Form
  text* screen.

---

## Monthly Disposition Report detail

The monthly return filed with the **Regional Civil Security Unit** under RA
11917: which clients the agency serves in the region, which guards are posted
there under which LESP licence, which firearms are deployed, who the agency's
officers are, and who joined or left. Operationally the sibling of the DDO —
that document authorises one post, this one reports the whole region.

- **Guards come from the 201 File, firearms from the Asset register.** *Pull
  guards from records* reads the active guards at a detachment with their LESP
  number and expiry, plus any firearm currently **open on the issuance ledger**
  (`status IN ('Issued','Partially Returned')`, as `routes/assets.js` defines
  it). Everything written is a snapshot and stays editable.
- **One month field.** `periodMonth` (`YYYY-MM`) renders the intro sentence, the
  certification line and the filename. The subject line is **composed** from the
  region and that month and is never stored, so a return cannot name three
  different months — which the source workbook does (February in its filename,
  July in its body, MAY in its certification).
- **Sections 1 and 3 are derived on read, never stored.** Both are counts over
  the return's own rows. A stored summary drifts from its own body.
  Recapitulation reports **postings and distinct guards side by side**, so a
  mid-month transfer shows as a visible discrepancy rather than a silent choice.
- **Firearms are a child table of a guard row**, because a guard can hold a
  pistol and a shotgun. As columns this needed a second personnel row, which
  double-counted the guard.
- **Validation lives in `mdrHelpers.js` and nowhere else.** `reportIssues()`
  produces the findings, `finaliseCheck()` the single verdict; the API serves
  both to the screen and obeys the verdict, and the frontend computes nothing.
  Severity is a declarative table, so the tiering can be read at a glance.
  - **blocking** (legal / data integrity): duplicate firearm · duplicated guard
    row · separated guard · missing firearm serial · written-off firearm ·
    missing province · invalid period. Finalise is **refused**; no override.
  - **advisory** (administrative): missing or upcoming LESP expiries, missing
    numbers, empty client block, guard at two posts. Finalise proceeds only
    with a typed reason, and the waived findings are snapshotted onto the
    return so the record shows what was filed knowingly.
  - Licence validity is judged against the **reported month**, not today, so
    reopening February's return in August invents no new expiries.
- **A finalised return is immutable**, enforced twice: every write route refuses
  a non-Draft return, **and** database triggers refuse any content INSERT,
  UPDATE or DELETE on it. The only update the triggers allow is a referential
  `SET NULL` on `employeeId`/`assetId`/`billingSiteId` — otherwise deleting an
  employee who appears on any filed return would fail, and the return would be
  holding the 201 File hostage. Nulling a link changes nothing the document
  prints, because every particular is a column on the row.
- **Workflow:** Draft → Finalised → Submitted. Finalise snapshots the
  letterhead and certification wording. **Reopen is only available from
  Finalised** — once a return has gone to RCSU, a correction is an amended
  filing, not an edit of the document they hold.
- The **PDF is A4 landscape** (Section 2 is eleven columns), re-stamps the
  letterhead on every page, and watermarks a draft `DRAFT - NOT FILED` in plain
  ASCII. Licence numbers and serials are sized to fit one line: a fixed-format
  identifier split across two lines is two half-numbers.
- The **GAIN table's headers are corrected**. The source sheet gives it the
  LOSSES headers ("DATE TERMINATED", "CAUSE(S) OF TERMINATION"); a gain prints
  "DATE HIRED / DEPLOYED" and "REMARKS". LOSSES keeps the original wording.

## Payroll disbursement detail

Turns an **Approved** pay period into an instruction to pay each guard's net
pay into their e-wallet or bank. Built in two stages; Stage 1 is live.

| Stage | What it does | Status |
|---|---|---|
| **1** | Capture payout details, build a batch, export a CSV the finance person uploads to the provider | **built** |
| **2** | Call the provider's payout API directly, with webhooks and per-guard reconciliation | not built |

- **CSOMS never moves money.** It reads computed net pay and the 201 File's
  payout details and writes a file. Payouts draw from a balance the agency
  tops up with the provider beforehand, outside this system.
- **Only from an Approved period** — that is the point at which the figures are
  agreed. One batch per period: preparing twice opens the existing batch rather
  than issuing a second instruction to pay the same payroll.
- **Skipped, never guessed.** A guard with net ≤ 0 (deductions carried forward)
  or incomplete payout details is listed with a reason rather than silently
  dropped or paid a wrong amount.
- **Masked everywhere but the file.** Account numbers show as `•••• 1234` in
  the API, the 201 File and the batch screen. The full number appears only
  inside the downloaded CSV. The audit trail records which fields changed,
  never their values.
- **Provider codes live in `xenditChannels.js` only.** Employee records store
  the human choice (GCASH / PAYMAYA / GOTYME / BANK), so re-coding a channel or
  changing provider is a one-file change. An unconfirmed code exports **blank**
  rather than invented — a wrong code pays the wrong rail.
- **GoTyme is a bank, not a wallet**: reached by bank account number and a bank
  code, not a mobile number.
- The item `reference` (`batch{id}-emp{employeeId}`) is the idempotency key.
  Stage 2 sends it to the provider so a retry can never double-pay.
- The **₱10/payout fee is an estimate** shown before export, from one named
  constant. A per-transaction processing fee (from Oct 2026) and a monthly
  minimum are announced but not modelled — see the file's own comment.

---

## Operational records analytics detail

Each of the Security Operations Dashboard's six operational-records tabs opens
with three KPI cards, a trend chart and a by-site breakdown, above the entry
form.

- **Every figure is computed in SQL, never in the browser.** `GET /ops/:type`
  caps at 200 rows. Daily Manning writes one row per guard per day, so eleven
  guards clear that inside a month — a count taken from the loaded list would
  describe a truncated window while presenting itself as the period total.
  Measured on a 260-row fixture: the browser would have reported **152 On Duty
  against a true 200**. `GET /ops/:type/summary` and
  `/ops/:type/timeseries-by-status` exist for this and nothing else.
- **The cards and the by-site bars are scoped to the window the trend draws** —
  `from` is the first bucket the trend returned — so a reader comparing the
  cards against the chart is comparing like with like.
- **One component, configured by a table.** `OPS_ANALYTICS` in
  `dashboardShared.js` names what each tab measures: whether the headline is a
  rate or a total, and which trend to draw. The six tabs differ in those, not in
  shape.
- **What counts as COMPLIANT is not in that table — it is a flag on the list
  value** (`dropdown_options.isCompliant`). It was `goodStatuses` in the
  frontend while the values themselves are admin-editable from Manage Lists, so
  renaming or re-casing "Complete" silently reclassified every record as an
  exception and turned the dashboard red with no error anywhere. There is no
  second copy to disagree now. `GET /meta/dropdown/:key/detail` serves the flags;
  the plain endpoint still returns a bare `string[]` for its eighteen callers.
  `NULL` means the list classifies nothing, which is the honest state for the
  twenty-one lists that do not.
- **A list value can be RENAMED, and the records come with it.** There was no
  rename at all before — only add and delete — so changing a wording meant
  delete + re-add, which left every record holding the old string. `PATCH
  /meta/dropdown/:key/:value` updates the option and its records in one
  transaction. Same rule the asset taxonomy has always had.
- **Deleting a value that records still use is refused** (409, with the count),
  again as the asset taxonomy refuses it. `src/lib/dropdownUsage.js` maps a list
  to where its values are stored — a mapping that existed nowhere, since no
  router referenced a list key. Only the **eleven ops lists verified against the
  code** are mapped; the other fourteen report "cannot check" rather than being
  guessed, because `training_type` lands in a column called `courseName` and a
  guard pointing at the wrong column reads as protection while protecting
  nothing.
- **When the list and the data disagree, the block says so instead of printing
  0%.** Nothing marked compliant, or records holding a value the list does not
  offer, replaces the rate and the exception count with "—" and names the cause.
  The charts drop their split and show plain counts for the same reason: a
  confident navy-vs-red breakdown beside a card saying the figure cannot be
  calculated is two opposite claims on one screen. A blank status is a data gap,
  not drift, and is left alone.
- **Comparison is case-, whitespace- and NFKC-insensitive** (`sameStatus`), so a
  pasted no-break space or different capitalisation still classifies correctly.
  It deliberately does not rescue a genuine rename — nothing at that layer can,
  which is what the delete guard and the rename route are for.
- **Operational-record writes are audited.** They were the one high-frequency
  thing in the system with no audit at all: `updatedAt` could say an edit had
  happened but nothing said who did it or what the value had been, so an
  overwritten status was simply unrecoverable. `ops.js` now logs
  `ops_record_added` / `_updated` / `_deleted` to the same `audit_log` the Live
  Feed reads, with the **previous value beside the new one**, and
  `ops_records.updatedBy` records the last editor. An update logs only the fields
  that changed, and nothing at all when a save changed none. A delete carries the
  row's particulars, since afterwards the log is the only place they exist. The
  audit write swallows its own errors — it must never break the action it is
  recording — and this is the highest-volume writer into Live Feed.
  - **Visitor and Vehicle Count read Period as a reporting WINDOW**, not a
    bucket size: Weekly draws a bar per day Mon–Sun, Monthly a bar per day of
    the month, Quarterly three monthly bars, Yearly twelve. A third filter
    (**Reference Period**) picks WHICH week/month/quarter/year, defaulting to
    the current one — never jumping to wherever the data happens to be, since
    an empty current month is a true answer. The other four tabs keep Period as
    the bucket size and have no such filter; the two behaviours are separated by
    the `windowed` flag, and the endpoint keeps its old meaning unless
    `from`/`to`/`bucket` are sent.
  - **Every bucket in the window is returned, including the empty ones**,
    zero-filled by `generate_series` in SQL. No row is written for them. Doing
    it server-side means the chart, the total, the peak and the average all read
    one list and cannot disagree.
  - They lead with a **total**, not a percentage — "83% of visitors" means
    nothing. The third card is the **peak day** or **peak month**, labelled to
    match the bucket, naming the date and taking the earliest bucket on a tie.
    A dashed average line spans the chart, averaged over ALL buckets so the
    quiet days count.
  - `ops_records.date` is a date with no time of day, so Daily means recent days
    (14 of them), not hours. There is nothing finer stored and inventing it would
    be a fabrication.
  - The exceptions card is always the danger tone. It is the number someone is
    meant to act on, and it reads zero when there is nothing wrong.
  - **Two stack shapes.** Daily Manning and Patrol Video are BINARY — navy
    compliant against red exceptions — because their second band genuinely is one
    thing. **Site Status and Site Manning Status draw one series per condition**
    (`stackMode: "status"`), because "no guards at all" and "short-handed", or
    Alert and Breach, are different severities and merging them answers "is
    anything wrong" while hiding which. The compliant series sits at the bottom
    of each bar, where the baseline is read.
  - **Per-condition colour is the one place a NAME is read** (`STATUS_TONE`):
    Normal/OK green, Alert amber, Breach red, Incomplete amber, No Guards red,
    Under Maintenance slate. That is a coupling to admin-editable wording, and a
    deliberate one — the alternative gives Breach whatever colour the palette
    reaches next. It degrades rather than breaking: an unmatched value falls to
    its compliant colour or the next fallback, matching is via `sameStatus`, and
    every FIGURE still reads `isCompliant`, never a name. Series membership and
    ORDER come from the list, so a value added in Manage Lists appears with no
    code change, and a status present in the data but missing from the list is
    appended rather than dropped.
  - **Both charts carry a native `<title>`** giving the full breakdown and total
    — on the bar group, not each segment, since a one-record segment is too thin
    to hit and the whole breakdown is the question being asked. No hover state,
    no positioning maths, and screen readers announce it.
  - The other two tabs get a line.
- **The block is opt-in per tab, because Deployment & Post Management renders
  the same `OpsRecordsTable`** for its seven tabs. A type absent from
  `OPS_ANALYTICS` gets no block — which is why those seven are unaffected.
- **It replaced the page-level Trends section**, which drew three column charts
  (Site Status, Visitor Count, Vehicle Count) above the tabs. Those three tabs
  now carry their own trend, so the section restated a subset of the per-tab
  blocks while covering none of the other three. `TrendChart`, `TREND_CONFIG`,
  `columnChartGeometry` and the `.trend-*` CSS went with it — it is removed for
  every user, being page structure rather than anything permission-gated.
- **ONE filter row drives the analytics AND the records list below it.** The
  row carries Site, Period, a **from–to date range** and, on the count tabs,
  Reference Period. The state lives in `OpsRecordsTable`; `OpsAnalytics` is
  controlled. Before this the row lived inside `OpsAnalytics` and the list took
  no filters at all — `GET /ops/:type` read only `limit` — so changing a
  selection moved the cards and the chart while the table underneath went on
  showing everything: two views of one tab disagreeing under one filter row.
  - **An explicit range OVERRIDES the period preset's window; clearing it hands
    the window back.** Both controls stay usable and nothing is lost by using
    one. The preset still sets the BUCKET SIZE on the four operational tabs, and
    the Reference Period picker on Visitor/Vehicle Count is preserved — it
    exists so those tabs never jump to wherever the data happens to be, and is
    disabled rather than hidden while a range is active.
  - **Under a range the trend draws buckets INSIDE it**, not the most recent N.
    Otherwise the cards would describe the range while the chart described
    something else — the same-window rule this block is built on, broken by its
    own filter. Bounded by `RANGE_BUCKET_CAP` so a wide range stays finite.
  - **The filter row is gated on `OPS_ANALYTICS[cfg.type]`** — the same flag
    that decides whether the analytics block renders. Deployment & Post
    Management renders this component for **seven tabs of its own** that have no
    entry there; they get no filter row and send no filter params, so their
    requests are byte-identical to before.
  - **`ops_records.date` is TEXT, not DATE**, so a range compare is neither a
    raw string compare (silently wrong on a malformed value) nor a bare
    `::date` cast (throws on one, taking the whole tab down for everyone).
    `pushDateRange()` casts only rows matching `^\d{4}-\d{2}-\d{2}$`: a value
    that is not a date cannot be inside a date range, so it is excluded from a
    range-filtered result and left alone everywhere else. See Known Gaps.
- **The site filter offers the configured Sites/Facilities list.** A record
  written against a site that is not on that list still counts in the totals and
  appears in the by-site bars; it simply cannot be filtered to. That matches the
  entry form, whose site picker is the same list.
- **No charting dependency.** The SVG geometry helpers (`lineChartGeometry`,
  `stackedBarGeometry`, `hBarGeometry`) sit beside the existing hand-rolled
  charts in `dashboardShared.js`. Bar width is **capped and the row centred** —
  four monthly buckets across the full width give 120px bars, which read as four
  blocks of colour rather than a series.
- `numericTotal` comes back from `SUM()` as a **string**; it is `Number()`d at
  the boundary, or the chart scales by lexicographic order.

---

## Access privileges

Per-user, per-module **Add / Edit / Delete**, extending the existing
authorisation rather than replacing it — `requireAuth`, the JWT session and
every existing `requireRole()` call are untouched.

- **A role's NAME on screen is not its stored key.** `ROLE_LABELS` in
  `permissions.js` maps three of them — `Admin` → *System Administrator*,
  `HR` → *HR Manager/Officer*, `Admin Officer` → *Security Admin Officer* — and
  is served to the UI through `/auth/permission-catalog` as `roleLabels`. Every
  `<option>` keeps `value={storedKey}`, so what is saved never changes. The
  stored strings must stay: they are the keys in 212 `requireRole()` calls, in
  `ROLE_DEFAULTS`, in `isSuperUser()`, in `useAuth()`'s `isAdmin`/`isViewer`, in
  the `users_role_check` constraint, and in the `role` claim of every JWT already
  issued — renaming the value would log out every signed-in user. A role absent
  from the map displays under its own name.
- **Security Admin Officer** defaults to six modules: Assets, Deployment,
  Security Reports, Recruitment and Compliance (add/edit/delete) plus System
  Settings (add/edit, never delete). It previously held Manage Lists and the
  201 File; both are deliberately gone.
  - **System Settings is therefore NOT `adminOnly` in the sidebar.** It is
    `requiresEdit: "settings"`, which today means Admin, the Owner and the
    Security Admin Officer. `adminOnly` contradicted the grant and hid the page
    from two roles the API had always accepted writes from — measured:
    `PATCH /settings` returns 200 for both. The page guard and the logo's
    **Remove** follow the same matrix, and Remove is `perm.delete`, so the
    Security Admin Officer can edit the branding but cannot clear the logo —
    exactly what "add/edit, never delete" says.
- **Changing a role default does NOT re-scope existing holders — but only
  because a migration makes sure of it.** `effectivePermissions()` reads
  `ROLE_DEFAULTS` live on every request; it is not snapshotted per user. So
  narrowing a role silently strips access from everyone holding it. `db.js`
  therefore freezes each existing `Admin Officer`'s pre-change access into
  explicit rows first, guarded by `migration_flags` so it runs once and cannot
  undo a later manual edit. It pins **all nineteen** modules, not just the five
  that were granted: a module left without a row falls through to the *new*
  default, which would have silently widened those accounts into three modules
  they never had. Any future role re-scope needs the same treatment.

- **Enforced in ONE place**, not at 200 call sites: `modulePermission(key)`
  wraps each router in `server.js`, so a new route inside an existing module is
  governed automatically. `/api/public` is deliberately unwrapped — it is
  unauthenticated and token-gated.
- **The method is the action**: `POST` → add, `PATCH`/`PUT` → edit, `DELETE` →
  delete, `GET` → nothing. Reads are NOT in this matrix; what a user may see is
  still `requireAuth` plus the existing role checks.
- **…except for the modules in `VIEW_RESTRICTED`**, which is now **19 of 20** —
  the eighteen the agency's access matrix governs, plus `executive`. Those get a
  fourth action, `view`, tested on `GET` by the same `modulePermission()`
  wrapper. Only `users` is outside it (Manage Users stays Admin-only via its
  route checks). The Privileges screen shows a View checkbox for the restricted
  ones. **Adding a module to that set closes it to everyone not granted it.**

### The agency's access matrix

`ACCESS_MATRIX` in `permissions.js` is the transcribed Module × Role table the
agency supplied, and it is the **source of truth for defaults**. Each business
role's `ROLE_DEFAULTS` is read off it by `fromMatrix()` — re-scoping a role
means editing the table and nothing else, so no second list can disagree with it.

- **An `O` grants view + add + edit.** Delete is not in the table: only the
  **Owner** holds it, per the agency's third business rule. `Admin` keeps delete
  as the technical super user — `isSuperUser()` short-circuits every check, and
  stripping it would leave nobody able to purge the audit log or fix a bad row.
- **A blank cell closes the module, including read.** That is the point of the
  table, and it is why almost every module is now view-restricted.
- **One deliberate addition to the printed table**: the Inspector holds
  `employees` and `assets`, which the agency's sheet leaves blank. Both are
  registers that Deployment and Security Reports are assembled *from* — a DDO
  names a guard from the 201 File and a firearm from the Asset register, and the
  MDR pulls both the same way. Without them an Inspector can open those modules
  but every guard and firearm picker is empty and "pull guards from records"
  returns 403. Approved by the agency; noted here because the table is otherwise
  authoritative and a future reader will diff the two.
- **The Security Operations Dashboard and Deployment & Post Management SHARE the
  `ops` router**, so the module is resolved PER REQUEST by `opsModuleFor()`, not
  at mount time. `modulePermission()` accepts a function of the request for
  exactly this. The dashboard was previously documented as having no API of its
  own; that was wrong — its six operational-records tabs and its three trend
  charts all read `/api/ops`, which was mounted wholly under `deployment`.
  Granting a user full access to *Security Operations Dashboard* therefore
  governed nothing on that page: every tab and chart answered **"You do not have
  access to this view"**. Measured across all nine roles.
  - `DASHBOARD_OPS_TYPES` in `permissions.js` names the six live tabs plus the
    three retired ones (`duty_roster`, `gps_monitoring`, `daily_metrics`) — their
    rows are still stored and still readable, so they stay with the page that
    wrote them. Anything else is Deployment's, which keeps the default on the
    module that has always owned this router.
  - This also closes the **Security Admin Officer's empty dashboard**: the matrix
    grants them `dashboard` but not `deployment`, so every tab was refused. They
    now read and write the dashboard's records and are still refused Deployment's
    own seven tabs and the duty detail orders.
  - A mount claimed by two modules is **left out of `MODULE_BY_MOUNT`** rather
    than resolved by declaration order, so nothing can silently attribute a
    dashboard request to Deployment.
- **`DashboardPage` gates on `useModulePerms()`**, like every other page. It was
  still reading `useAuth()`'s role flags, which cannot see a per-user grant — so
  an administrator who ticked Add/Edit on the dashboard still got a read-only
  page. Same one-line shape as the rest: `const isViewer = !perm.edit`.
- **"Full access" in the Privileges screen is a shortcut, not a fifth
  privilege.** It sets the same four columns the API already stores, so nothing
  new is persisted and the server check is unchanged. It is *derived* from those
  four rather than held as its own state, so unticking any one of them unticks it
  — the row and the shortcut can never disagree about what is granted. View is
  ignored for a module whose reading is open to everyone, or the box could never
  read as full however much was granted.
- **A module closed to a narrow audience must ALSO be named in
  `CLOSED_TO_LEGACY`.** The two legacy roles are defined by EXCLUSION —
  "every module except `users`/`settings`/`executive`" — so every module key
  added to the system lands in their grant by default. `usefulLinks` is opened
  to the Owner alone in `ACCESS_MATRIX`, and without the matching exclusion a
  legacy `Investigator` would have received add+edit and a `Viewer` view, which
  is the opposite of the intent. Measured across all nine roles: Admin and Owner
  200, the other seven 403.
- **Two things are deliberately NOT in the table** and keep their prior
  behaviour: `users` (Admin only), `executive` (Owner plus a per-user grant),
  and the Security Operations Dashboard, which has no module key at all because
  it reads across modules and writes nothing.
- **Shared reference data must stay readable, or the matrix breaks every page.**
  `/api/meta` (dropdown lists, sites, classifications) belongs to `lists`, and
  `/api/settings` (company name and logo, on every header and PDF letterhead)
  belongs to `settings` — both of which the matrix closes to most roles. They
  are mounted with `modulePermission(key, { openRead: true })`, which leaves
  **GET** ungated while writes stay governed. Without it, five of six roles
  silently lose every dropdown and all branding. Measured, not theorised: 36
  cross-module 403s across the six roles before that flag existed.
- **A granted write implies `view`.** Nobody can add an employee on a screen
  they cannot open, so `effectivePermissions()` forces `view` true whenever
  add/edit/delete is granted. Otherwise an override ticking Add but not View
  would grant a privilege and hide the only place to use it.
- **The legacy roles need `view` stated explicitly.** Before the matrix, reads
  were open everywhere and `Investigator`/`Viewer` relied on that. With 19
  modules restricted, a legacy role carrying no `view` reads **nothing** — a
  Viewer sees no module at all, and an Investigator is locked out of the pages
  they still hold edit on. Both now carry `view` on every module but `executive`.
- **Existing accounts are re-scoped on purpose here**, which is the opposite of
  the `Admin Officer` freeze below. The `apply-agency-access-matrix` migration
  deletes the rows that freeze stamped (`updatedBy = 'migration:freeze-admin-
  officer'`) so those accounts fall through to the matrix. Only rows still
  carrying the migration's own marker are removed, so a deliberate per-user
  override set by an administrator since then survives.
- **Frontend enforcement is in two places**: `Sidebar` hides a module the role
  has no `view` on, and `RequireModuleView` in `App.jsx` wraps every module
  route so typing the URL is blocked rather than merely unlisted.
- **A user with no rows behaves exactly as before.** `ROLE_DEFAULTS` encodes
  today's behaviour, and the two legacy roles (`Investigator`, `Viewer`) are
  derived from the routes rather than guessed — Investigator is add+edit
  everywhere *except* Manage Users and System Settings, which have always been
  Admin-only. Getting that generous would hand them settings they never had.
- **A granted privilege is not overruled.** When the matrix allows a write,
  `req.moduleGrant` is set and `requireRole()` defers — otherwise granting
  "delete on Assets" would be silently refused by a `requireRole("Admin")`
  further down and the privilege screen would be decorative.
- **Workflow steps are exempt from that deference.** Finalising a return,
  issuing an order, approving, marking paid: those keep whatever role their
  route demands, so holding "edit" lets someone *build* a document, not *file*
  it. Both checks must pass. See `WORKFLOW` in `permissions.js`.
- **…and so are protected administrative actions.** `PROTECTED` in
  `permissions.js` exempts the same way, for a different reason: purging the
  cross-module audit log is a `DELETE` that happens to live in the Incidents
  router, so the matrix handed `moduleGrant` to every role with delete-on-
  Incidents and `requireRole("Admin")` stepped aside. Owner and Operation
  Manager could both wipe the audit history — measured at 200, not theorised.
  A destructive action whose route names a role must be listed here.
- **Resolved per request, never embedded in the JWT** — a permission baked into
  a token cannot be revoked until the next login. Cached 10s and dropped
  outright whenever a user's permissions or role change.
- The frontend reads `/auth/my-permissions` only to avoid offering an action
  that would be refused. **Hiding a button is not security**; the API re-checks
  every write, and the test suite proves it with a forged-but-valid token.
- **The UI gates on `useModulePerms()`, never on the role.** `lib/modulePerms.js`
  maps the route to its module key and returns that user's effective
  Add/Edit/Delete. Pages previously gated on `isViewer`/`isAdmin`, which cannot
  see a per-user override: a denied user still saw the control and got a 403 on
  click, and a *granted* user never saw it at all. Save, delivery, the server
  check and Reset were all working — the UI was the only broken link.
  - Each page keeps its single derived flag and repoints it: `const isViewer =
    !perm.edit`. That is the whole fix for ~300 call sites; only the create
    controls (`perm.add`) and record deletes (`perm.delete`) are named
    separately, because those are different privileges.
  - `perm.<action>` already means **"Admin, or the matrix grants it"** — `can()`
    short-circuits for Admin — which is exactly what `requireRole()` enforces
    server-side. So converting an `isAdmin`-gated Delete matches the API rather
    than widening it.
  - **Workflow steps keep their role check.** Approve, Reject, Finalize, Reopen,
    Mark Paid, Issue stay `isAdmin` — `WORKFLOW` in `permissions.js` exempts
    them from the matrix on the server too, so both checks must pass.
  - A route with no module (`/dashboard`, `/live-feed`) returns **`null`, not
    `false`**, so a page can tell "not governed by the matrix" from "governed and
    denied" instead of silently hiding all its controls.
  - `ROUTE_MODULE` is asserted against the server's own `MODULE_KEYS`: a typo
    there would hide every control on a page rather than crash. And `perm` used
    inside a sub-component is a **`ReferenceError` at render that both the build
    and the linter pass** — one shipped that way and was caught only by loading
    every route. The suite renders all 19.

## Passwords and sessions

- **A password change ends every session that predates it.** `users.passwordChangedAt` is stamped on any password write — self-service, admin reset, or the admin PATCH — and `requireAuth` refuses a token whose `iat` is older. Without this a reset was cosmetic: JWTs here are stateless and signed for 12 hours, so the holder of a stolen token carried on regardless. Cached 10s like the permissions, and dropped immediately on write.
- **Self-service never takes a target.** `POST /auth/change-password` changes `req.user.id` and nothing else; a `userId` or `username` in the body is ignored. It also refuses a new password equal to the current one.
- **An admin reset issues a generated temporary password, shown once.** `POST /auth/users/:id/reset-password`, Admin only and enforced server-side. The password is returned to the admin exactly once and stored **only** as a bcrypt hash — never in the audit log, never on the row. Lost means reset again. It sets `users.mustChangePassword`, which `/auth/login` and `/auth/me` both report, so a resumed tab is prompted as well as a fresh login; changing the password clears it.
- **An admin cannot reset their own account from that route** — it would hand them a temporary password and kill their own session mid-flow. They are sent to Change password, which asks for the current one first.
- **Account events are audited** (`password_changed`, `password_reset`, `password_set`) with `incident_id` null, naming who acted and on whom. **No password ever goes in the log.**

## Conventions that matter

- **Times.** Punches are UTC instants; guards work PH time (UTC+8, no DST). Always convert via `phTime.js`. `to_char` **and a bare `::date` cast** on a `timestamptz` render in the *session* timezone (UTC on the server) — use `AT TIME ZONE 'Asia/Manila'`. This bit the attendance punch window: `"punchAt"::date` put a 06:00 PH punch on the previous UTC day, so every morning punch on the **first day** of a report period was dropped and the day read Absent. Night shifts were unaffected, which is why it survived so long.
- **Migrations.** `src/db.js` runs on every boot. Everything must be `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, and backfills need a guard flag so they can't re-apply.
- **Money.** Never hardcode statutory figures or premium multipliers — they live in `payroll_statutory_config` and are admin-editable. Billing's commercial terms (fee percentages, the man-hour divisor, default rates) live in `billing_config` for the same reason — and the two **fee percentages** may additionally be overridden per client, with NULL meaning the agency-wide figure.
- **Money in PDFs.** Use `pdfMoney.js` — **"PHP 8,550.00", never `₱`**. PDFKit's built-in fonts are WinAnsi-encoded, so `₱` (U+20B1) is written as byte `0xB1` and renders as `±`. The web UI is unaffected and still shows `₱`.
- **History.** Computed rows snapshot names/rates so later edits don't rewrite the past. Catalog entries deactivate rather than delete.
- **Education levels are ranked by their list order.** `educationRank.js` holds them ascending, and the 201 File's Level picker renders that same sequence — one list, one order, so a display order cannot quietly disagree with the ranking. "Highest Educational Attainment" is derived from it in `fullEmployee()` and stored nowhere. A level the list doesn't know is reported verbatim and ranked below every known one, never dropped. Note `dropdown_options.education_level` is a **dead seed** read by nothing; don't wire it up.
- **Configurable lists.** Flat lists shared by several modules live in `dropdown_options` and are maintained from Manage Lists. A list that is hierarchical, or that only one module can meaningfully consume, gets its own tables and its own tab inside that module — see the asset taxonomy. A value can be **renamed and the records follow**, and **cannot be deleted while records use it** — the same two rules the asset taxonomy has always had. Where a list classifies compliance, that is a **flag on the value** (`isCompliant`), never a copy in frontend config that could disagree with it.
- **Authenticated downloads.** PDFs sit behind `requireAuth`; use `apiBlobUrl` + `downloadBlobUrl`. `window.open` cannot attach the bearer token and returns 401.
- **Cards inside modals.** `.section-card` and `.kpi-grid` carry a 32px horizontal margin for full-page layouts. Inside a `.modal-body` that double-insets them against plain elements beside them, so a scoped rule cancels it — put button rows and cards side by side in a modal and they will line up.
- **Every page footer comes from `ConfidentialFooter`, never hand-written.**
  Shift Scheduling kept its own copy with the agency name hardcoded, so the fix
  to the shared component did not reach it and it went on printing a former
  client’s name on a line that says CONFIDENTIAL. A page writing its own
  CONFIDENTIAL line is the bug, not the wording.
- **The client branding is re-read when the session becomes authenticated.**
  `SettingsProvider` wraps the login screen too, so its mount-time fetch runs as a
  GUEST, 401s, and falls back. Nothing re-ran it after login, so anyone who
  arrived at the login form kept the fallback name for the whole session — in the
  sidebar, all 21 headers and every page footer. It looked like a per-role bug
  because a restored session fetched successfully. It now keys off `status ===
  "authed"`. There is **no hardcoded company name** left as a fallback: an
  unloaded name renders as nothing, because a former client’s name shown as this
  agency’s is worse than no name.
- **The login screen is branded from `GET /api/settings/public`**, which is
  unauthenticated because its visitor has no token. It returns the company name,
  whether a logo exists, and a cache-busting version — and names those three
  fields explicitly, so a column added to the letterhead later cannot leak to an
  anonymous caller. The authenticated `GET /settings` still carries the address,
  mobile, email, LTO number, RCSU addressee and named contacts, and still 401s
  for a guest.
- **Excel exports carry the letterhead too** (`lib/xlsxBranding.js`): company
  name, report title, range and generated date above the data. The **logo is not**
  in Excel — embedding an image needs SheetJS Pro and the community build cannot
  write one. PDFs carry the logo because PDFKit can draw it.
- **Two brandings, never merged.** The company name and logo in `app_settings` are the CLIENT's — each agency sets its own, and they drive the sidebar, module headers, page footers and every PDF letterhead. The author/licence strings in `appBranding.js` identify the SOFTWARE and are fixed. Both appear together; neither ever replaces the other.
- **PDF footers.** Every `new PDFDocument` takes `bufferPages: true` and every `doc.end()` is preceded by `stampAuthorFooter(doc, companyName)` — without buffering only the last page can be stamped. A route calling it without importing it is a runtime error `node -c` cannot see, so the branding suite asserts the wiring statically.
- **The roster legend is derived, never hardcoded.** `buildLegend()` in `SchedulingPage.jsx` reads the loaded shift templates (and the week's assignments, so a kind on screen is never missing from the legend because its template was deleted) and emits one entry per **`shiftKind`** — because that is what the roster cells are coloured by. Listing one entry per *template* would imply a distinction the cells do not draw, since two templates of the same kind share a swatch; the template names are shown on the entry instead, and a name that merely restates its kind is dropped. Adding a kind means adding it to `SHIFT_STYLE` + `KIND_LABEL` in that file and to `SHIFT_KINDS` in `routes/scheduling.js` — adding a *template* needs nothing.
- **`shiftKind` is snapshotted by all four assignment writers.** Three of them (`/assignments/range`, `/assignments/copy-week`, and the rest-day restore) used to omit it, leaving an empty kind until the next boot's backfill guessed one from the times — which silently reclassified any template an admin had deliberately marked. `rest_days.prevShiftKind` exists so the kind survives the rest-day round trip. The boot backfill remains as a safety net for pre-existing rows.
- **Equal start and end times are deliberately ambiguous.** `06:00 → 06:00` could be a 24-hour tour or a mis-entry, so `derivesCrossesMidnight()` refuses to guess and defers to the admin's *Overnight* checkbox or *Shift kind* picker; with neither, it reads as a Day shift. Do not "fix" this into an assumption.
- **Sticky tables.** `.section-card` is a scroll container, which captures `position:sticky`. Use `.sticky-card` + `.sticky-head`; offsets come from `lib/stickyOffsets.js` and `--module-header-h`.
- **Wide tables scroll, they do not clip.** `.section-card` is `overflow-x:auto` (not `hidden`) — with `hidden` a table wider than its card had its right-hand columns silently unreachable: measured on Incidents at 900px, a 1119px table in a 604px card, 515px of columns invisible with no scrollbar. **`.sticky-card` is deliberately exempt** and keeps `overflow:visible`: an `overflow-x:auto` ancestor moves the sticky containing block onto that box and the frozen header dies (measured: pinned at `top:163` → `-539` after the same scroll). The two features are mutually exclusive. Below 1200px the cell gutters tighten to 10px so the sticky tables fit without needing a scrollbar at all.
- **A grid's column count is data, never an inline style.** `.kpi-grid` takes `data-cols="N"`. An inline `style={{gridTemplateColumns}}` outranks every stylesheet rule *including media queries*, so thirteen grids could never collapse on a phone and laid five tiles across a 326px viewport. The breakpoints repeat `[data-cols]` in their selector to match the per-count rules on specificity — without that, `[data-cols="8"]` (0,2,0) beats a bare `.kpi-grid` (0,1,0) and the collapse silently does not happen.
- **Form controls are styled by exclusion, in `:where()`.** The rule matches every `input` *except* checkbox/radio/file/button/submit/reset/range/color. Listing types instead left 31 number inputs, 4 datetime-local, 2 time, 2 password and every untyped input rendering as a raw browser control beside styled ones. `:where()` contributes **no specificity**, so the rule weighs (0,0,1) and stays a default that component rules override — the same list written with `:not()` would weigh (0,8,1) and silently beat every component rule in the file.
- **The Bootstrap shim is a seam, not a backlog.** The block at the end of `index.css` is permanent: Bootstrap is a CSS layer here by decision, so nothing is migrating onto its components and the block will never empty. `.modal` is the one genuine blocker — it means the *opposite* thing in each system, and Bootstrap's `display:none` would hide all 68 dialogs.
- **Errors stay inline; toasts are for success.** `toast.*` is for the "it worked" moment, especially when the effect is invisible. The ~187 `setError(...)` paths are deliberately NOT toasts: an error belongs beside the control that caused it, where it stays put while the user fixes the field.
- **Errors.** Express 4 does not catch async route errors. Handle them in the route — the process guards in `server.js` only prevent a crash, they don't answer the request.
- **`GET /healthz` names the running commit.** `{ ok, db, commit, startedAt }`,
  where `commit` is the 7-character sha from `appVersion.js`. Deploys are often
  backend-only, and the only external deploy signature used to be the frontend
  bundle's content hash — which does not move when no frontend file changed, so
  a server-only push could not be confirmed live at all (Render's zero-downtime
  swap hides the restart too). Resolution order is `RENDER_GIT_COMMIT` →
  `GIT_COMMIT` → `SOURCE_VERSION` → the local `.git` — the platform variable
  first, because it names what was BUILT, while a container's checkout only
  describes what happened to be copied in. With none of them it reports
  **`"unknown"`**; it never invents a sha, since a wrong one is worse than none.
  Unauthenticated like the rest of the endpoint: a commit sha identifies a build
  without disclosing anything about a private repo.

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
9. **Guard rank on a DDO is a text field** (`SG`, `SO`), inferred from the employment position, because the 201 File has no rank column.
10. **A DDO's thirty-day validity is not auto-renewed.** A lapsed order reads Expired; reissuing is deliberate, since the detail may have changed.
11. **Firearm licence data is per asset, not per licence document.** If one licence covers several firearms, its expiry must be entered on each.
12. **No provider channel code is confirmed yet.** GCash and Maya use the documented PH codes; GoTyme and banks export blank until the agency's provider onboarding supplies them. Confirm every code, the real fee schedule, and the funding/top-up mechanics before the first live payout.
13. **Disbursement Stage 2 is not built.** The file is uploaded to the provider by hand; nothing in CSOMS calls a payout API, and no payment credentials exist in the repo or on Render.
14. **The MDR is built to the agency's own reference return, NOT to a verified PNP-SOSIA issuance.** Secondary sources describe the prescribed format as including *LESP category* — now captured on the 201 File, admin-maintainable from Manage Lists, but **not yet printed on the MDR** — and *educational attainment*, which the 201 File now derives per employee (`highestEducation`) — both are captured but **neither is printed on the MDR yet**, because the reference return has no column for either and inventing one would be a guess. SOSIA also runs an **Online DDO-MDR portal**, so filing may be an upload rather than a PDF. Obtain the current SOSIA form before the first live filing; the section labels and certification wording are composed in `mdrHelpers.js` and would move to an admin-editable config, as the DDO's wording did.
15. **An expired LESP or firearm licence is advisory, not blocking, by decision.** The argument for blocking is strong, but the filing deadline is statutory and a renewal in process is common: blocking would mean the agency cannot file at all because one licence sits with SOSIA, and filing late is the worse violation. It requires a typed override and is recorded. Two entries in `ISSUE_SEVERITY` flip it.
16. **The MDR's Small Arms / Light Weapons split follows the source return**, which files a 12GA shotgun as a light weapon. Defaulted from the calibre and overridable per firearm; confirm against the current SOSIA form.
17. **Public uploads are not virus-scanned.** The Missing Time Log form accepts
    JPEG/PNG/PDF from an unauthenticated caller and stores them as BYTEA. Type is
    verified by magic bytes and downloads are forced as attachments with
    `nosniff`, so the bytes are never executed or rendered inline — but no
    scanner exists in this stack. Accepted deliberately; revisit if the agency
    ever needs to forward these files outside CSOMS.
18. **Province is entered per client block on the MDR.** Sites/Facilities records no province and Sections 1 and 3 group by it. Carried forward from the previous month once one exists.
20. **A recompute silently UN-APPROVES a period, and leaves no trace that it
    was ever approved.** `POST /payroll/periods/:id/compute` ends with an
    unconditional `SET status = 'Computed'`, so an Approved period is quietly
    returned to Computed; only `Paid` is refused. Nothing records the loss:
    `payroll_periods` has no `approvedBy`/`approvedAt`, and the approve route
    writes no audit entry — so after a recompute there is no way to answer
    "was this approved before?" other than checking whether a
    `disbursement_batches` row exists, which only ever proves the positive.
    This has bitten twice: once healing the NaN columns and once healing the
    night differential. Adding `approvedBy`/`approvedAt` plus an audit write on
    approve would close it; queued, not done.

    **QUEUED DIRECTLY BEHIND the payroll override layer's stage (iii).**
    Accepted deliberately once, for the 2026-08-16..18 re-approval on
    2026-08-26: that period had no disbursement batch, so nothing downstream
    depended on the approval and a filed register PDF plus a dated manual note
    was proportionate. That reasoning does NOT extend to the next one. An
    approval that a batch and a payment file rest on must not be recorded by an
    unattributed `updatedAt` that the next write to the row overwrites.

26. ~~**No suite covers an override INTERACTING with the arrears/deferral
    path.**~~ **CLOSED**, on two legs rather than one.

    **Verified against PRODUCTION**, not only in the engine: the one live line
    carrying arrears or a deferral — Rommel E. Abuyabor's, `deductionsDeferred`
    ₱53.94 — was read back and reconciled against its own itemised components.
    `gross − (sssEe + philhealthEe + pagibigEe + withholdingTax +
    otherDeductions + arrearsRecovered)` returned **0.00, equal to its stored
    `netPay` of 0.00**. One specimen, not an empty result — an empty one would
    have meant no line exercises this path at all, which is not a pass.

    The standing check, read-only, for the next time a line carries arrears:

    ```sql
    SELECT pl."employeeNo", pl."netPay",
           pl."arrearsOpening", pl."arrearsRecovered", pl."deductionsDeferred",
           round(pl."grossPay" - (pl."sssEe" + pl."philhealthEe" + pl."pagibigEe"
                 + pl."withholdingTax" + pl."otherDeductions"
                 + pl."arrearsRecovered"), 2) AS should_equal_netpay
      FROM payroll_lines pl
     WHERE pl."arrearsOpening" > 0 OR pl."arrearsRecovered" > 0
        OR pl."deductionsDeferred" > 0;
    ```

    **And by construction**: `scripts/payroll/override-arrears.js` drives the
    pure engine directly (no HTTP, no fixture rows) across twelve ladder shapes
    and asserts five invariants on each:

    1. **reconciles** — `gross − (the itemised deductions the PAYSLIP prints,
       i.e. `withheld.*`, plus `arrearsRecovered`) == netPay`;
    2. **conserves** — `totalWanted == totalTaken + deductionsDeferred +
       (arrearsOpening − arrearsRecovered)`;
    3. `arrearsRecovered <= arrearsOpening`;
    4. `arrearsClosing == arrearsOpening − arrearsRecovered + deductionsDeferred`;
    5. `0 <= netPay <= grossPay`.

    **Invariant 2 was got WRONG on the first pass, and that matters more than
    the gap did.** The obvious form — `totalWanted == totalTaken +
    deductionsDeferred` — is false whenever arrears exist, because
    `deductionsDeferred` deliberately covers only THIS cutoff's unmet deductions
    (`payrollEngine.js:752-756`): unrecovered OPENING arrears was already
    carried and stays in `arrearsClosing` rather than being deferred twice.
    Asserting the obvious form would have failed against correct code and sent
    someone hunting a defect that does not exist.

    **The freed peso goes to the next unmet item in ladder order**, measured
    rather than reasoned: with gross exhausted it moves to the next
    contribution; with a surplus and arrears outstanding it goes to **arrears**,
    exactly; with a surplus and no arrears it reaches **net**, exactly.

    **The one real edge was a NEGATIVE override**, now refused at the engine —
    see the `makeOverrides()` note in *Payroll detail*. Invariants 1–4 held
    BEFORE that guard, on every case including the negatives; only invariant 5
    broke, and only on an input the API already refused. The guard is
    defence-in-depth, not a repair.

25. **An ORPHANED payroll override sits unflagged.** `reconcileOverrides()`
    only compares overrides for fields the engine actually computed on that run
    (`if (!freshByField.has(row.fieldName)) continue`). If an employee has no
    payroll line that period — separated, hired later, or simply not computed
    — any standing override on them is neither applied nor flagged, and nothing
    surfaces it. That is correct behaviour rather than a defect: there is no
    computed base to compare against, so calling it stale would assert a
    divergence nobody can evaluate. But the override stays in the table,
    invisible, and would silently take effect again the moment a line reappears
    for that employee and period. A "standing overrides with no matching line"
    listing on the period screen would close it. Recorded, not built.

24. ~~**DECISION PENDING — the Owner holds payroll OVERRIDE but not attendance
    EDIT.**~~ **RESOLVED TOGETHER**, as the gap said it should be. *Owner /
    President / General Manager* was added to `ATTENDANCE_EDIT_ROLES` in the same
    change that wired the payroll allowlists, so the list is now
    `["Admin", OPS_MGR, OWNER]` — an addition; Admin and the Operations role are
    untouched. The reasoning is the asymmetry's own: a role trusted to override
    a STATUTORY contribution, changing what the agency remits to government, is
    not plausibly untrusted to correct a punch's site. The standing `PENDING
    GRANT` note in `permissions.js` is removed, since leaving it would imply an
    intention still unfulfilled. **Accounting / Payroll was NOT added** to
    attendance edit: correcting a punch moves man-hours between two clients'
    invoices, which is operational rather than a payroll act.

23. ~~**`PATCH /lines/:id` re-implements net pay by hand, and gets it wrong.**~~
    **CLOSED** when the override allowlists were wired. The route no longer
    computes net pay at all: adjusting Other Deductions now records an override
    on `otherDeductions` and `computeEmployeeLine()` re-derives net through its
    own priority/cap/arrears ladder. The formula that omitted arrears and the
    gross cap is deleted rather than corrected — a second implementation of the
    money maths should not exist in a better form, it should not exist. The edit
    now also SURVIVES a recompute, where before the next compute silently
    overwrote it.

22. **`payroll_statutory_config` accepts any number, with nothing between a
    typo and payroll.** `PUT /billing/config` already refuses a fee percentage
    outside 0–1, because entering `12.24` for `0.1224` would bill 1224%. The
    statutory tables have no equivalent check, and it has already cost real
    money: `philhealth.ratePercent` was stored as **0.025** instead of ~5, so
    the premium computed as 0.025% of monthly comp — ₱2.14 against ₱427.50
    for a ₱570/day guard, a 99.5% under-withholding on both the employee and
    employer shares, on every line computed while it stood. It took a payslip
    investigation to find, because ₱2.14 is a plausible-looking number and
    nothing flagged it. The same band check belongs on the SSS, PhilHealth,
    Pag-IBIG and withholding-tax tables: a rate outside a sane range, a floor
    above its ceiling, or an employee share exceeding the total should be
    refused at the API rather than silently priced. **This is the systemic
    lesson from that incident** — the engine was correct throughout; the input
    was not, and nothing checked it.

    **The same coercion trap has now appeared three times**, which is why this
    guard matters more than any single fix: `?? default` letting a malformed
    rule value through as `NaN` or a silent 0; `philhealth.ratePercent = 0.025`
    accepted as a rate; and `Number(null) === 0` nearly accepting an ABSENT
    payroll override as a deliberate "set this field to zero". Each was caught
    by a test that fed the code deliberately malformed input. `Number(x)` on
    unvalidated data is the recurring defect — type-check before coercing.

21. **`arrears-e2e` depends on the ambient statutory config without declaring
    it.** The suite seeds a single worked day in a 16–31 cutoff and expects the
    full month's contributions to exceed gross, which only happens while the
    Pag-IBIG/SSS/PhilHealth cutoffs resolve to `second`. Point a dev database at
    `first` and it fails with three assertion errors that look like an arrears
    regression and are nothing of the kind — observed while testing the
    per-contribution cutoffs. The suite should set the config it depends on
    rather than inheriting whatever the database happens to hold.

    **This is one instance of a pattern.** A back-compat suite that loads the
    previous implementation with `git show HEAD:...` becomes SELF-REFERENTIAL
    the moment the change it guards is committed — it then compares the new
    code against itself, and any input the new code no longer reads makes every
    case "fail". `cutoff-unit.js` hit exactly this after the statutory split
    landed and is now pinned to an explicit revision. Back-compat suites must
    pin a named commit, never `HEAD`; and a suite that depends on config must
    set that config rather than inherit it.

19. **The AGENCY-WIDE billing cadence is still two free numbers.** A client picks
    one `billingCadence` and both operands are derived from it, so an
    inconsistent pair is unreachable there. The default pair in `billing_config`
    — `periodsPerMonth` and `standardPeriodDays` — is still set independently,
    and they are two fields meaning one thing: exactly the smell the per-client
    design removed. `PUT /billing/config` refuses a pair whose product is not
    28–31 days, which closes the hole; replacing the pair with a global default
    *cadence* is the tidier end-state and is deliberately deferred, because it
    reworks the Billing Rules screen.

27. **`src/db.js` runs `migrate()` at MODULE IMPORT, so any script that reaches
    it migrates whatever `DATABASE_URL` points at.** `db.js:2926` is
    `const ready = migrate().catch(...)` — not a function someone calls, but a
    side effect of `require`. The server wants that. A diagnostic script does
    not: `computeReport()` requires `../db`, so a "read-only" check that reuses
    the compute path silently runs the full DDL and every guarded backfill
    against production the moment it is imported. Nothing warns about it, and
    the statements are all `IF NOT EXISTS`, so it succeeds quietly and looks
    like nothing happened.
    `scripts/payroll/override-inertness-check.js` works around it by
    pre-populating `require.cache` for `db.js` with its own guarded pool before
    requiring anything, so `migrate()` never runs — and installs a write guard
    on `pg.Client.prototype.query`, the one chokepoint both `pool.query()` and
    any borrowed client pass through. **Wrapping `pool.query` and `pool.connect`
    instead does NOT work**: pg's own `Pool.query` calls `this.connect(callback)`,
    so an override that ignores the callback never resolves and the first query
    hangs for ever — measured, and the reason the guard sits where it does.
    The real fix is to export `migrate` and let `server.js` invoke it, leaving
    `require("./db")` a pure connection handle. That is a small change with a
    wide blast radius (every module importing `db.js` currently relies on the
    import having started the migration), so it is recorded rather than done.

28. **`ops_records.date` is TEXT, not DATE.** Every other date column in the
    system is a real `DATE` or `TIMESTAMPTZ`; this one stores `'YYYY-MM-DD'` as
    text with no constraint. It works only by convention, and the convention is
    unenforced: a value in any other shape sorts wrongly, filters wrongly and
    groups wrongly, with no error anywhere. The range filter added for the
    dashboard works around it by casting only rows that match
    `^\d{4}-\d{2}-\d{2}$` (`pushDateRange()` in `routes/ops.js`), because a bare
    `::date` cast throws on a bad row and takes the endpoint down for every
    user while a raw string compare is silently wrong. Both are workarounds for
    a column that should be `DATE`. The fix is a migration that validates and
    converts, plus a `CHECK`; deferred because every write path and the six
    dashboard tabs read it, and no malformed row is known to exist today —
    dev measured 0 of 14. Verify production before converting.

29. **The override modal hardcodes the statutory reason CATEGORIES while the
    endpoint already returns them.** `GET /payroll/periods/:id/overrides`
    answers `{ overrides, reasonCategories }`, where `reasonCategories` is
    `STATUTORY_REASON_CATEGORIES` from `lib/payrollOverrides.js` — the same list
    the server VALIDATES against on write. `PayrollOverrideModal.jsx` ignores
    that half of the response and carries its own `CATEGORIES` copy.
    They agree today. If the server's list is ever edited, the modal keeps
    offering the old wording and every submission using a removed category is
    refused with a 400 the admin cannot act on, because the option that caused
    it is still on screen. Exactly the drift that put a stale
    `ATTENDANCE_EDIT_ROLES` in `frontend/src/roles.js` — a mirror that was right
    when written and wrong the moment its source moved.
    The fix is to read `reasonCategories` from the response the modal already
    fetches and fall back to the local list only until it loads, which is a few
    lines and no new request. Recorded rather than done: it surfaced during a
    live hotfix for an unrelated crash in the same function, and widening that
    commit would have put an untested UI change on the money path.
