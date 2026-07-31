# React Migration Plan — CSOMS Frontend

# React Migration Plan — CSOMS Frontend

**Status: Phase 0 complete.** The React shell is live at `/app` alongside the
current production app at `/` (untouched). See "Phase 0" below for exactly
what was built and how it was verified.

**Current state:** `public/index.html` — 5,554 lines, ~276KB, 220 functions, 16
modals, 11 modules. Backend (Express + Postgres) needs **zero changes** — this
plan only replaces `public/`.

---

## The one decision that makes this tractable

Seven of your eleven modules (DSR, Disciplinary Action, Performance Appraisal,
Training, Compliance & Audit, Recruitment, and Deployment & Post Management's
record types) are **the same shape**: a list view with filters → a detail
modal with a workflow stepper, tabs, attachments, and a PDF button. Right now
each one is ~400-600 lines of hand-copied HTML template strings and fetch
calls with a different prefix (`da_`, `pa_`, `tr_`, `ca_`, `rc_`...).

In React, this becomes **one generic component**, configured per module:

```jsx
<EntityModule
  resource="disciplinary"
  code="DA"
  title="Disciplinary Action & Infraction Management"
  stages={["Open","Under Review","Resolved","Closed"]}
  listColumns={[...]}
  detailTabs={[
    { key: "overview", fields: [...] },
    { key: "attachments", type: "attachments" },
  ]}
/>
```

That single abstraction is the highest-leverage piece of this migration —
it's most of the reason the codebase is 5,500 lines today, and most of why
it'll shrink dramatically in React.

---

## Tooling (opinionated defaults, easy to swap)

| Concern | Choice | Why |
|---|---|---|
| Build tool | **Vite** | Fast dev server, minimal config, standard for new React apps |
| Routing | **React Router** | Turns `switchModule('dsr')` into real URLs (`/dsr`) — bookmarkable, back-button works |
| State | **React Context** (Auth) + local component state | App isn't complex enough to need Redux/Zustand; avoid the extra dependency |
| Data fetching | Plain `fetch` wrapped in a small `api.js` (mirrors your current `api()` helper almost exactly) | No need for React Query at this scale, though it'd be a nice-to-have later for caching |
| Charts | Keep your hand-rolled SVG pie/column charts as components | They already work and match your brand; no need to pull in Recharts |
| Styling | Keep your existing CSS as global stylesheet | Your navy/gold design system doesn't need to be rebuilt — just import the same `<style>` block as `index.css` |

---

## Phased plan

### Phase 0 — Scaffold (no user-visible change) ✅ DONE
- `frontend/` — Vite + React 19 project, React Router installed
- `frontend/src/index.css` — your full navy/gold design system ported
  **verbatim** from the current `<style>` block (all CSS variables, every
  component class like `.sidebar-link`, `.btn-gold`, `.kpi-card`, etc.)
- `frontend/src/nav.config.js` — the sidebar's three section headers (Core /
  Operation / Compliance / System Administration Layer) and all 11 module
  routes, as one data-driven config instead of hand-written HTML
- `frontend/src/api/client.js` — fetch wrapper mirroring the vanilla app's
  `api()` helper: bearer token handling, 401 → auto-logout, plus upload and
  blob-URL helpers for attachments/PDFs
- `frontend/src/context/AuthContext.jsx` — login/logout/session-resume,
  matching the vanilla app's `tryResumeSession`/`doLogin`/`doLogout` flow
- `frontend/src/pages/LoginPage.jsx` — the navy/gold login screen
- `frontend/src/components/Sidebar.jsx` — renders from `nav.config.js`,
  hides Admin/Viewer-restricted links automatically
- `frontend/src/components/ModuleHeader.jsx` — the reusable navy header bar
  every module page uses
- `frontend/src/pages/PlaceholderModule.jsx` — stand-in shown for all 11
  modules until their real implementation lands in later phases
- **Rollout wiring**: Express now serves the React build at `/app`
  (`src/server.js`), while `/` keeps serving the current production app
  completely unchanged. `vite.config.js` sets `base: '/app/'` and a dev
  proxy so `npm run dev` talks to the real Express API on :3000. The
  Dockerfile builds the frontend automatically on deploy.

**How this was verified:** built the frontend clean, booted the real server
against a real Postgres database, and confirmed: `/` still serves the
current app byte-for-byte unchanged; `/app` serves the React shell; React
Router's client-side paths (e.g. `/app/incidents`) resolve via the SPA
fallback; built JS/CSS assets resolve correctly under `/app/assets/`; and
the login screen's exact API calls (`/api/auth/login`, `/api/auth/me`) work
against the live backend with a real admin account.

**Try it yourself:** `cd frontend && npm install && npm run build`, then
start the server as usual and visit `/app`. You'll see the real sidebar,
the real login screen (log in with your real credentials), and — after
logging in — a placeholder page for whichever module you click, each
telling you which phase will replace it with the real thing.

### Phase 1 — Shell & Auth
- Login screen component
- Sidebar component (with your three section headers: Core/Operation/Compliance/System Administration Layer)
- Layout shell (header + content area) that every module renders into
- **Deliverable:** you can log in, see the sidebar, navigate between empty module pages

### Phase 2 — The `EntityModule` abstraction
- Build the generic list + detail-modal + stepper + attachments + PDF component described above
- Prove it out against **one** real module — Disciplinary Action is a good pick (medium complexity, no sub-resources beyond attachments)
- **Deliverable:** Disciplinary Action fully working in React, feature-parity with today

### Phase 3 — Migrate the remaining "shaped" modules
Using `EntityModule` from Phase 2, each of these is mostly configuration, not new code:
- Daily Security Report (add: approval workflow variant — Submit/Approve/Reject/Reopen)
- Performance Appraisal (add: KPI score fields)
- Training & Certification (add: expiry-date filtering/badges)
- Compliance & Audit (add: checklist + corrective-action sub-resources)
- Recruitment (add: multi-tab detail view, checklist, equipment log, KPI cards)
- **Deliverable:** 6 of 11 modules done, each individually testable against the same backend

### Phase 4 — The bespoke modules
These don't fit the generic shape and need their own components:
- Incident Reporting & Investigation (evidence/witnesses/actions sub-resources, Excel export, public form link sharing)
- Security Operations Dashboard (KPI cards + pie/column charts + trend filters)
- Deployment & Post Management (multiple record types in one module, each with different fields)
- Live Feed (simple, low effort)
- **Deliverable:** all 11 modules complete

### Phase 5 — Admin pages
- Manage Users (straightforward table + form)
- Manage Lists (dynamic tabs per dropdown key — can actually also use a generic component here, since every tab is the same Add/Remove list pattern)
- **Deliverable:** full feature parity with the current app

### Phase 6 — Cutover
- Point Express's static-file serving at the new build permanently
- Delete the old `public/index.html` (keep in git history)
- Update the Dockerfile to add a build stage (`npm run build` before `node src/server.js`)
- **Deliverable:** old file retired, React is production

---

## Rollout strategy (de-risking)

You don't have to do this as one big-bang release. Two safe options:

1. **Side-by-side path:** serve the React build at `/app` while `/` keeps serving the current `index.html`, until Phase 6. Test in production without touching what your team uses daily.
2. **Branch-based:** build entirely on a branch, deploy to a separate Render service temporarily, cut over via DNS/link-sharing once Phase 5 is done.

Either way — the backend API doesn't change, so both versions can run against the same Neon database simultaneously with zero data risk.

---

## What doesn't change at all

- Database schema, all 20+ tables
- Every Express route in `src/routes/*.js`
- Auth mechanics (JWT in a token, role-based permissions)
- Render deployment target (same service, just a build step added)
- `report.html` / `dsr-report.html` public forms — these are simple enough to leave as static HTML indefinitely, or port last, whichever you prefer

---

## Honest sizing

This is a multi-session effort — I'd estimate Phase 0-2 (shell + proving out the core abstraction) as the first real milestone worth pausing at to sanity-check the approach before committing to Phases 3-6. I'd suggest we do exactly that: build through Phase 2, you look at it running against your real data, and decide whether to continue or stay vanilla for the rest.

Want me to start on Phase 0?
