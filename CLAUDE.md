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
| **Attendance & Timekeeping** | Selfie + GPS punch capture via public link; register with search, site/guard/type filters and date range; reports for Daily Attendance, Late & Undertime, Overtime; Excel + branded PDF export; **unrostered duty days** (a punch on a day with no roster entry) shown as their own Present row rather than vanishing; absence monitoring with follow-ups; **per-row delete on Daily Attendance** (removes the punch RECORDS behind a line — the line is derived from the roster and returns as Absent; Owner-only, per the matrix); Missing Time Log requests with single and **mass** approval. Reviewing a request settles the matching absence follow-up automatically — Approved → **Actioned**, Rejected → **Excused**. **Duty site is CHOSEN on both public forms, not copied from the 201 File** — a guard on relief duty works a post that is not their assigned one — and a choice that disagrees with the roster puts the day on a billing hold (see *Duty site detail*). The Missing Time Log form also takes an **optional stamped selfie and up to three JPEG/PNG/PDF attachments** |
| **Leave Management** | Requests with approval workflow; VL/SL credit balances; automatic paid/LWOP split on approval; guard vs non-guard day counting; approved leave suppresses "Absent" in attendance |
| **Payroll & Benefits** | Semi-monthly periods; Daily/Monthly rates; attendance-driven gross pay; night differential; holiday pay; statutory deductions; withholding tax; arrears carry-forward; pay components; 13th-month pay; payslip + register PDFs; **disbursement** of net pay to e-wallets and banks (see detail below). Salary computation list itemises **Basic Pay, Night Differential, Built-in OT and Excess OT** as separate peso columns (see detail below) |
| **Billing & Statement of Account** | Clients each owning detachments; per-site contract rate, standard shift hours and contracted headcount (inheriting client → agency defaults); billing periods independent of payroll with Draft → Issued → Paid. **A site-level man-hour model, anchored to the punch and ignoring the roster**: each site-day nets the man-hours actually worked against `contractedGuards × dutyHours` into ONE figure — short is a LESS, over is an ADD, never both. The flat period rate covers a **fixed 15-day standard** (admin-editable), so a 16-day period augments the extra day and a 13-day February credits the two days that have no calendar date — plus **manual ADD** for billable overtime and two per-line **holiday-pay** amounts folded into the taxed base. **An incomplete IN/OUT pair counts zero, credits the client, and blocks Issue** until a Missing Time Log correction supplies the punch; sites with attendance but no detachment are surfaced. Per-day evidence behind every figure; SOA PDF per detachment (or the whole run) plus a computation-sheet register; admin-editable fee percentages, **optionally overridden per client** (see detail below) |
| **Asset & Equipment Management** | Register of every trackable item, security and non-security; three-level **Asset Type → Category → Sub-Category** classification, admin-maintainable and **owned solely by this module**; serialized and bulk tracking; issue → return with partial returns, loss and damage write-offs; **Equipment Accountability Form** PDF per issuance, on the agency letterhead with logo, downloadable straight from the issue dialog; inventory PDF; attachments; alerts for overdue returns, returns due soon, warranty/replacement, and low stock (see detail below) |
| **Recruitment & Onboarding** | Applicant pipeline, interview notes, background/medical/licence checks, onboarding checklist, equipment issuance, attachments |

### Operation Layer
| Module | Capabilities |
|---|---|
| **Security Operations Dashboard** | Incident KPI cards and pie charts; operational records — **Daily Manning** (Deployment Status), **Site Status** (Site Condition; no separate Notes — “Site note” is its free-text field), **Site Manning Status** (Complete / Incomplete / No Guards), **Patrol Video** (Video Patrol Status: Complete / Incomplete, plus a **Post Type**: Farm / Gate / Egg Store), **Visitor Count** and **Vehicle Count** (a count for a site on a date — no Description; Notes carries the rest). Guard names are **picked from the 201 File** (`Full Name — Employee No`), and all three status lists are admin-maintainable from Manage Lists. **Each of the six tabs carries its own analytics block** above the entry form — three KPI cards, a trend chart and a by-site breakdown, with site and period filters (see detail below) |
| **Incident Reporting & Investigation** | Incidents with evidence, witnesses, corrective actions, attachments, PDF report, Excel export, **public no-login report form** shared from this module. The JSON backup export and the in-module Activity log were removed at the agency's request — the cross-module audit lives in **Live Feed**, which is access-controlled |
| **Deployment & Post Management** | Site profiles, post orders, deployment planning, reliever management, vacancy tracking, manpower requirements, **Detail Duty Order** (see detail below) |
| **Shift Scheduling** | Shift templates and per-day roster **sortable by Employee No, Name or Site** (click to sort ascending, click again to reverse); `crossesMidnight` derived from the times; **`shiftKind` (Day / Night / Straight Duty / Broken)** stated on the template and snapshotted onto **every** assignment; **broken (split) shifts** carrying a second time range on the same row; a **roster legend derived from the templates**, so a new shift type appears with no code change; explicit rest days that restore the prior shift — its kind and both ranges — when removed |
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
| Night hours 22:00–06:00 | +10% of the day's **base** rate — every hour in the window counts, including hours inside OT, but they are not uplifted by the OT multiplier (that premium is already paid by the OT columns). The holiday multiplier still applies. |
| Regular holiday — unworked / worked / OT | 100% / 200% / 260% |
| Special non-working — unworked / worked / OT | 0% / 130% / 169% |

- **Built-in OT** — shift length beyond 8h is auto-recognised (a 12h shift = 8h + 4h), earned by time actually worked past the 8-hour mark. No approval needed.
- **Straight Duty** — a continuous 24-hour tour is NOT one long shift. It is computed as **two consecutive regular shifts** (06:00-18:00 then 18:00-06:00), the same built-in rule applied to each half and the two summed: 4h + 4h = **8h built-in OT**, not the 16h a single 24h shift would give. Base pay follows the same reading (`shiftUnits = 2`, so two day rates): describing the same 24 hours as two shifts in the OT column and one in the pay column would leave eight hours paid by neither. A Straight Duty therefore pays **16h regular + 8h at the OT multiplier** — the full 24 hours accounted for.
  - **Excess OT is measured from the guard's own time-in, not the rostered end.** The tour is twenty-four hours of duty, so starting an hour late means finishing an hour later before any of it is overtime; only what is worked past that 24-hour mark can be excess. Everything *inside* the tour is already recognised as built-in, and counting it twice would put the same minutes in the column that needs approval. This replaced a blanket `overtimeMin = 0`, which was over-broad — the figure it discarded was time worked *after* the tour ended, so a guard genuinely held over was recorded as having done no excess overtime at all. Undertime stays measured against the **rostered** end, as for every other shift.
  - **One record per tour, however the roster entered it.** A 24-hour tour touches two calendar dates and is commonly entered on both. Each entry used to produce its own record, and the second was worse than redundant: its punch window caught the tour's closing punch but no opening one, so it reported the guard **Absent** on a day they had worked — a false absence that fed absence monitoring and the billing LESS deduction. The second entry is recognised as a straight duty for the same guard and post beginning exactly where the previous day's ended, and is suppressed.
  - **A straight duty gets a 6-hour trailing punch window** (the leading edge stays at 2h). With the ordinary 2h pad a tour running even 2h01 over had its closing punch discarded — which cost not just the time-out but the whole 8h of built-in OT, since built-in requires an OUT.
- **Broken (split) shift** — one duty day worked in two non-contiguous stretches, e.g. 06:00–12:00 then 00:00–06:00 the next morning. Both ranges live on the **same assignment row** (`startTime2` / `endTime2` / `crossesMidnight2`), so one duty day stays one attendance record and the 8-hour threshold spans the whole duty instead of being tested twice against two short halves that would each earn nothing. The example is 12h of duty, so the eighth hour falls two hours into the second stretch: **02:00–06:00 is built-in OT**, and it sits wholly inside the night window, so night differential applies to it. That is arithmetic, not a special case.
  - **The gap is not worked and must never be paid.** `computeReport()` puts the actual stretches on the row as `workedIntervals`, and `payrollEngine` walks those instead of `timeIn → timeOut`. Read contiguously, the example spans 24 elapsed hours and pays **8h** of night differential where only **6h** were worked, plus 2h of regular time nobody was on duty for. Every other kind of shift has no `workedIntervals` and keeps the original contiguous arithmetic untouched — including its 8-hour mark, which is measured from the *scheduled* start so arriving late does not quietly convert regular hours into overtime.
  - Excess OT is time past the **last** stretch's rostered end; the split itself never creates any.
- **Excess OT** — worked past shift end, beyond a threshold. Requires approval.
- **Statutory** — SSS / PhilHealth / Pag-IBIG withheld on a configurable cutoff (default: 16th–end only). Withholding tax is assessed **every** cutoff with half the month's contributions in the tax base, so both payslips carry an even tax burden.
- **Tax** can be switched off company-wide, or per employee (`taxExempt`, for minimum-wage earners under RA 9504).
- **Arrears** — deductions are capped at gross so net can never go negative; the shortfall carries to the next cutoff. Priority: current statutory → voluntary → prior arrears. Balances move **only at Mark Paid**, so recomputing a draft can't double-count.
- **Holidays** — two axes: `type` sets the multiplier, `sites` sets who it applies to (empty = nationwide, populated = a local holiday).
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
- **Resolution is a deliberate act by a named person.** `PATCH
  /absence-monitoring/missing-timelog/:id/resolve-site` re-reads the roster and
  **refuses with 409 while the two still disagree**, so the button cannot make an
  unreconciled day billable: the admin corrects the roster in Shift Scheduling or
  corrects the submission first. Both the flag and its resolution go to
  `audit_log` (`site_mismatch_flagged` / `site_mismatch_resolved`).

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
- **The SOA's "N Day(s)" is GUARD-days, not calendar days.** `hoursAsDays()`
  divides by the post's standard shift, so 72 h at a 12 h post prints as
  "6 Day(s) - 72 Hours" — six guard-shifts not rendered, which is what the
  client is being credited for.
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
- **Two caps.** Each shift counts at most `dutyHours` (05:44–18:01 is 12 h, not
  12 h 17 m), and each guard contributes at most `dutyHours` per site per day —
  one person cannot fill more than one post's daily requirement however many
  times they come and go.
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
billingPeriodRate = (contractRate / 2) × guards
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
- **An incomplete IN/OUT pair counts ZERO man-hours and HOLDS the day.**
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
