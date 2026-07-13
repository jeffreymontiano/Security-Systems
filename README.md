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

This is a new, honest-scope version of the "Security Operations Dashboard"
concept: it currently shows only what the system actually has real data
for — it does **not** fake guard deployment, GPS tracking, visitor counts,
or vehicle counts, since none of those data sources exist yet.

What it does show, all from real incident data:
- The same KPI cards and pie charts as the incident dashboard (total
  incidents, open cases, avg. resolution time, breakdowns by status/site/
  classification/severity)
- A **live activity feed** — the 15 most recent actions across the whole
  system (any incident created, updated, attached to, etc.), visible to
  Admin, Investigator, and Viewer alike
- A **"Coming soon"** panel that's upfront about what this module will
  eventually include (guard deployment, duty roster, GPS monitoring, visitor
  count, vehicle count) once those subsystems are built — so it matches the
  intended module vision without pretending those pieces already work.

When those data sources get built as their own modules, this dashboard is
the natural place to wire their metrics in.

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
