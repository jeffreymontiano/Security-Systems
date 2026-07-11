# Brookside Farms CSOMS — Incident Reporting & Investigation (multi-user)

A self-hosted version of the Incident Reporting & Investigation module with real
accounts, login, and role-based permissions, so your CCTV/Security/IT team can
use it together online instead of it living only in one browser.

## What changed from the single-user version

- **Login required.** No data is visible without signing in.
- **Node.js + Express backend**, **Postgres database (Neon)** storing users,
  incidents, evidence, witnesses, and corrective actions.
- **Roles:**
  - **Admin** — everything, plus managing users and deleting incidents.
  - **Investigator** — report incidents, update stages, add evidence/witnesses/actions,
    manage the classification & site lists.
  - **Viewer** — read-only. Can see the register, KPIs, and export to Excel, but
    cannot create or edit anything.
- Same navy/gold Brookside look and feel, same KPI dashboard, same Excel export.

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
  (who did what, when) for accountability — not yet exposed in the UI, but
  the data's there if you want an audit report added later.

## If something needs adjusting

This is a first working version — deployment target, roles, or extra fields
(e.g. a 4th role, incident attachments/photo upload, email notifications) can
all be added. Just say what you'd like changed.
