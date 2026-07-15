# Brookside Farms CSOMS — Incident Reporting & Investigation (multi-user)

A self-hosted version of the Incident Reporting & Investigation module with real
accounts, login, and role-based permissions, so your CCTV/Security/IT team can
use it together online instead of it living only in one browser.

## What changed from the single-user version

- **Login required.** No data is visible without signing in.
- **Node.js + Express backend**, **Postgres database (Neon)** storing users,
  incidents, evidence, witnesses, corrective actions, attachments, and an
  audit trail.
- **Roles:**
  - **Admin** — everything, plus managing users, deleting incidents, and
    viewing the system-wide activity log.
  - **Investigator** — report incidents, move them through the workflow,
    add evidence/witnesses/actions/attachments, manage the classification
    & site lists.
  - **Viewer** — read-only. Can see the register, dashboard, and export to
    Excel or PDF, but cannot create, edit, or delete anything.
- Same navy/gold Brookside look and feel.

### Feature additions in this version
- **Dashboard** — KPI cards plus pie-chart breakdowns by status, site,
  classification, and severity, opened via a "Dashboard" button so the main
  register view stays uncluttered.
- **Simplified workflow** — Open → Under Investigation → Resolved → Closed,
  shown as a clickable stepper on each incident.
- **Attachments** — upload photos and documents (images, PDF, Word, text;
  up to 8MB each) directly on an incident; stored in Postgres, viewable and
  downloadable from the Attachments tab.
- **Audit log** — every create/update/status-change/attachment/deletion is
  recorded with who did it and when. Visible per-incident (Activity log tab)
  and system-wide for Admins (header → Activity log).
- **Search & filtering** — free-text search plus filters for classification,
  status, site, severity, and date range.
- **PDF incident report** — "Download PDF report" on any incident generates
  a branded report covering the overview, evidence, witnesses, actions, and
  attachments list.
- **Mobile-responsive** — the register becomes a card list, modals go
  full-screen, and the dashboard/toolbar reflow on narrow screens.
- **Public report form** — a no-login form at `/report.html` that anyone
  with the link can use to submit an incident (with an optional photo/document
  attached), for personnel who don't have system accounts. See below.
- **Left sidebar navigation** — the app now has a left-hand menu with two
  entries: **Module 7 (Incident Reporting & Investigation)**, the existing
  register, and **Module 5 (Security Operations Dashboard)**, a new
  command-center-style view. This is meant to grow as more CSOMS modules
  get built — new modules just become new sidebar entries.

## Module 5 — Security Operations Dashboard

Module 5 now has full CRUD for every item from the original feature list
except **Active incidents** (which correctly pulls from Module 7's real
incident data rather than being duplicated here). Everything below is real,
persisted data — not placeholders:

- **Guard deployment status** — who's on duty, off duty, on leave, per site
- **Site status monitoring** — per-site status notes (Normal/Alert/Breach/Maintenance)
- **Duty roster** — scheduled shifts, with status (Scheduled/Completed/No-show/Cancelled)
- **GPS guard monitoring** — manual check-in/check-out log with a location field
  (there's no GPS hardware integration — this is a manual log until that's built)
- **Visitor count** — logged entries per site/date
- **Vehicle count** — logged entries per site/date
- **Daily operational metrics** — a general-purpose metric log (name + value)

Each shows up as its own tab under **Operational Records** on the dashboard,
with a table of existing entries (editable inline) and an "add new" row.
Same role rules as everywhere else: Viewers can see but not edit; Investigators
and Admins can create/edit; only Admins can delete.

Also on this dashboard: the same KPI cards and pie charts from the incident
dashboard, plus a **Trends** section with column (bar) charts for Site
Status activity, Visitor Count, and Vehicle Count — each with its own
Daily/Weekly/Monthly/Quarterly/Yearly dropdown, so you can see volume over
time at whatever granularity is useful.

The **live activity feed** has its own sidebar entry now (see below) rather
than living inside this dashboard.

## Navigation & administration changes

- **Sidebar order**: Security Operations Dashboard → Incident Reporting &
  Investigation → Deployment & Post Management → Daily Security Report →
  Manage Users (Admin only) → Manage Lists (hidden from Viewers) → Live Feed.
- **Manage Users** and **Manage Lists** are now full sidebar pages instead of
  modals opened from the Incident module's header — same functionality, just
  their own space, and reachable from anywhere in the app now.
- **Manage Lists** now covers 8 configurable dropdowns total: the original
  Classifications and Sites, plus six new ones for Deployment & Post
  Management — Post Orders status, Deployment Planning status, Reliever
  Management status, Vacancy Tracking status, Shift Assignments status, and
  Shift Assignments shift (Day/Night). Each has Add and Remove buttons; the
  actual dropdowns in Deployment & Post Management read live from these
  lists, so a change here shows up immediately in those forms.
- **Public form links** — the existing "Share form link" feature (Admin →
  header button) now shows two links: the incident report form and a new
  **Daily Security Report form**, both protected by the same
  `PUBLIC_FORM_TOKEN`. Anyone with the DSR link can submit a report (saved
  as a Draft) without logging in — useful for guards/supervisors filing an
  end-of-shift report from their phone. A matching button now also lives in
  the DSR module's own header.
- **Live Feed** now has a date-range delete tool (Admin only): pick a from/to
  date and permanently remove activity log entries in that range. This is a
  genuinely destructive operation — there's no undo — so it's kept to Admin
  and requires both dates before it'll run.

## Deployment & Post Management

A fourth sidebar entry with full CRUD for guard deployment and site coverage
planning, covering every item from that module's feature list:

- **Site profiles** — a record per site (name/notes plus a "client / contract
  ref." field)
- **Post orders** — status-tracked (Draft/Active/Under Review/Retired)
- **Deployment planning** — guard-to-post assignments with a "post / shift"
  field, status Planned/Confirmed/Deployed/Cancelled
- **Reliever management** — who's covering for whom, status Assigned/
  Completed/Cancelled
- **Vacancy tracking** — open posts, status Open/Filled/Escalated
- **Shift assignments** — status Scheduled/Completed/No-show/Cancelled
- **Site manpower requirements** — required headcount per post/role

Same tabbed layout as the Security Operations Dashboard's Operational
Records section, same role rules (Viewer reads only; Investigator/Admin
create & edit; Admin-only delete). Under the hood this reuses the same
generic records system as Module 5 rather than a separate one — same table,
same API shape, just a different set of record types and its own tab group,
so both modules stay easy to maintain together.

## Daily Security Report (DSR)

A fifth sidebar entry (positioned before Live Feed), built as a proper
report entity rather than a flat records list, since it needs an approval
workflow — this one has its own dedicated database table, not the shared
Module 5/11 records system.

**Covers every item from the feature list:**
- Shift turnover reports, visitor logs, vehicle logs, patrol reports,
  security observations, and site issues — all captured as sections of a
  single daily report per site/shift
- **Attachments / photos** — same upload/view/download pattern as incidents
- **Approval workflow** — Draft → Submitted → Approved/Rejected. Investigators
  and Admins can create and submit reports; only Admins can approve, reject,
  or reopen one after review. Once Approved or Rejected, a report locks
  against further edits until an Admin reopens it — this preserves the
  integrity of what was actually approved.
- **Reporting periods** — the list view filters by Daily / Weekly / Monthly /
  Annual (or All), using real date-range filtering against the database, not
  a client-side approximation.

I tested the full lifecycle end-to-end: create → submit → attempt-edit-while-
submitted (allowed) → approve → attempt-edit-while-approved (correctly
blocked) → reopen → edit again (allowed) — plus confirmed Viewers can read
but not create, and Investigators can't approve their own or others' reports.

### Module numbering removed from the UI
The "Module 5" / "Module 7" labels have been dropped from both module
headers, the sidebar menu, and the login screen — the sidebar now just shows
plain names ("Incident Reporting & Investigation" / "Security Operations
Dashboard"). The module numbers still exist internally (this doc, code
comments) for your own reference against the 17-module CSOMS plan, but
nothing in the actual interface surfaces them anymore.

## Public, no-login report form

There's a second, much simpler page — `/report.html` — for people who need
to report a security incident but shouldn't (or don't need to) have a full
account: gate guards, farm workers, contractors, etc. It asks for their name,
what happened, where, and lets them attach a photo, then creates a normal
incident record (status "Open") that shows up in the register for your team
to triage.

**This form is off by default.** To turn it on:

1. Generate a share token:
   ```bash
   node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
   ```
2. Set `PUBLIC_FORM_TOKEN` to that value — in your local `.env` for testing,
   and in **Render → your service → Environment** for production. Restart/redeploy
   after setting it.
3. Log in as Admin → click **Share report link** in the header → copy the link
   and send it to whoever needs it (WhatsApp, email, printed QR code, posted
   at a guardhouse, etc.). The link already has the token baked in — nobody
   needs to type anything technical.

**Anyone with that exact link can submit reports without logging in** — so
treat the link itself the way you'd treat a shared password. If it ever leaks
somewhere it shouldn't, generate a new token, update the environment variable,
redeploy, and share the new link — the old one stops working immediately.

A few built-in protections: the endpoint is rate-limited (30 submissions per
15 minutes per network), includes a basic bot honeypot, and every submission
is tagged in the audit log as coming from the public form along with the name
the person entered, so it's always clear which incidents came in this way.

## 1. Run it locally first (recommended before deploying)

Requires [Node.js 20+](https://nodejs.org) and your Neon connection string
(Neon dashboard → your project → **Connection Details**).

```bash
cd incident-system
npm install
cp .env.example .env
```

Edit `.env`:
- Paste your Neon connection string into `DATABASE_URL` (keep `?sslmode=require`
  at the end — the app uses it to detect it should connect over SSL).
- Generate a real `JWT_SECRET`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
  Paste the output in as `JWT_SECRET=...`
- Set `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` — this creates your
  first Admin account the very first time the server starts against an empty
  database. Change the password after your first login.

Then:
```bash
npm start
```
The first run automatically creates all the tables in your Neon database and
seeds the default classification/site lists plus your Admin account — you
don't need to run any SQL by hand. Open **http://localhost:3000** and log in.
As Admin, use **Manage users** in the header to create accounts for your team
(CCTV Team, Technical Support, HR, etc.) with the right role each.

> Tip: Neon databases auto-suspend when idle and wake up on the next query —
> the very first request after a quiet period may take a second or two
> longer while it wakes up. Totally normal.

## 2. Put it online so others can reach it

You need somewhere to *host* the Node process persistently — Claude can't host
it for you, but any of these work well and are inexpensive:

### Option A — Render.com (easiest, has a free tier)
1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `node src/server.js`
4. Add environment variables from your `.env` (`DATABASE_URL`, `JWT_SECRET`,
   `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_NAME`).
   No persistent disk needed — Neon holds all the data.
5. Deploy. Render gives you an `https://your-app.onrender.com` URL to share.

### Option B — Railway.app
Same idea as Render: connect the repo, set the same env vars, deploy.

### Option C — Your own VPS / Brookside server (most control)
1. Install Node.js 20+ on the server.
2. Copy this folder over (or `git clone`), `npm install --omit=dev`.
3. Set up `.env` as above with a real `JWT_SECRET`.
4. Run it under a process manager so it survives reboots:
   ```bash
   npm install -g pm2
   pm2 start src/server.js --name csoms-incidents
   pm2 save && pm2 startup
   ```
5. Put it behind Nginx with HTTPS (e.g. via [Certbot](https://certbot.eff.org/))
   so people aren't logging in over plain HTTP:
   ```nginx
   server {
     listen 443 ssl;
     server_name incidents.brooksidefarms.example;
     location / {
       proxy_pass http://localhost:3000;
       proxy_set_header Host $host;
     }
   }
   ```

### Option D — Docker (works on any of the above, or a company server)
```bash
docker build -t csoms-incidents .
docker run -d -p 3000:3000 --env-file .env --name csoms-incidents csoms-incidents
```

> **Important either way:** always serve this over HTTPS in production —
> passwords and session tokens should never travel over plain HTTP once it's
> reachable outside your own machine. Render/Railway give you HTTPS
> automatically; on your own VPS, use Nginx + Certbot as shown above.

## 3. Day-to-day use

- **Admin** logs in → **Manage users** → create an account per teammate with
  the right role.
- Everyone logs in with their own username/password at the shared URL.
- Incidents, evidence, witnesses, and corrective actions are now shared and
  live for everyone the moment they're saved — no more exporting/importing
  JSON files between people.
- Excel export still works exactly as before, per-user, on demand.

## Data model notes

- Your Neon project is the single source of truth. Neon takes automatic
  backups/point-in-time restore on its own (check your plan's retention
  window in the Neon dashboard) — no separate backup step needed on your end.
- Every create/update/delete/stage-change is written to an `audit_log` table
  (who did what, when) — visible in-app under Activity log.
- Attachments (photos/documents) are stored directly in Postgres as binary
  data, capped at 8MB per file. This keeps deployment simple (no separate
  file storage service to set up), but heavy attachment use will grow your
  database size faster than incident data alone — worth keeping an eye on
  against your Neon plan's storage limit. If that becomes a real constraint,
  the next step would be moving attachments to object storage (e.g. Cloudflare
  R2 or S3) instead of the database — say the word if you'd like that swapped in.

## If something needs adjusting

This is a first working version — deployment target, roles, or extra fields
(e.g. a 4th role, incident attachments/photo upload, email notifications) can
all be added. Just say what you'd like changed.
