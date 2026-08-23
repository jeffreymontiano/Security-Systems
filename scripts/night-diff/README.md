# Night-differential verification tooling

Built to verify the change that made night differential attach to **paid**
minutes only (see *Payroll detail* in `CLAUDE.md`, and `COMMIT2-NOTES.md`).

Kept in the repo rather than thrown away because the same question recurs
whenever the night rule, the punch-pairing window or the shift model changes:
*which duty rows carry night differential, why, and what would a rule change do
to each of them?*

None of this is loaded by the application. It is operator tooling.

## Which tool to use

| You have | Use |
|---|---|
| A direct database connection | `night-diff-audit.js` |
| Only a SQL console (e.g. the Neon editor) | `night-dump.sql` → `night-analyse.js` |

### `night-diff-audit.js` — needs a connection string

```bash
node scripts/night-diff/night-diff-audit.js 2026-08-16 2026-08-18 --db "<conn>"
node scripts/night-diff/night-diff-audit.js 2026-08-16 2026-08-18 --json
```

Read-only and **enforced**, not merely intended: `src/db.js` is never loaded
(its `require.cache` slot is pre-filled, so `migrate()` cannot run), and every
statement runs inside its own `BEGIN READ ONLY`. Session-level read-only is
deliberately NOT used — these are Neon **pooler** endpoints, and a session GUC
set through PgBouncer persists on the shared backend and is inherited by
whoever is handed it next. Measured once on dev: it made an unrelated client's
INSERT fail. Against production that would have made the live app read-only.

It classifies each row and predicts its post-change value. **It is a
pre-deploy tool.** Once a rule change is live, its "NIGHT now" column describes
the rule that no longer exists and its drift check inverts.

### `night-dump.sql` + `night-analyse.js` — for a SQL console only

`night-dump.sql` is one read-only `SELECT`. It contains **no night-window
arithmetic**: it dumps raw inputs only — scheduled window, punch in/out,
approved OT minutes, and the stored figures — so it cannot disagree with the
engine. Edit the two dates at the top.

Run it, export CSV, then:

```bash
node scripts/night-diff/night-analyse.js rows.csv
```

`night-analyse.js` prices every row through **`computeEmployeeLine` itself**,
twice: once with the engine as it stands, once with an older revision loaded
straight out of git. The rule is therefore never paraphrased.

Two things it does on its own, both deliberate:

- **It names the minutes it removes** (`05:51-06:00, before scheduled start`)
  and checks the named intervals account for the entire delta. A movement it
  cannot explain is reported as `UNEXPLAINED`, not rounded off.
- **It cancels the dump's minute truncation.** The SQL prints whole minutes, so
  a punch at `17:55:30` reads as `17:55`. Comparing a prediction built from
  truncated inputs against a stored value computed from exact instants shows
  phantom one-minute deltas. Running *both* engine revisions over the *same*
  truncated inputs makes the truncation cancel. The residual is reported as
  `resid`; anything above 1 minute means the dump's nearest-punch pick disagrees
  with the engine's own allocation and that row must not be trusted.

`rows.sample.csv` documents the input format. It holds **synthetic guards
only** — a real dump carries employee names and daily rates and does not belong
in version control.

## Reading the verdict

```
night/straight-duty moving    0   -- a night or straight-duty guard losing
                                    night differential needs explaining before
                                    anything ships
unexplained movements         0   -- must always be 0
truncation residual > 1 min   0   -- above 0, check the punch pairing
TOTAL PHP REMOVED         11.77   -- gross and net must EACH fall by exactly
                                    this after the period is recomputed
```

Statutory contributions are computed from `dailyRate x monthlyDivisor` rather
than from gross, so a night-differential change moves gross and net by the same
amount unless withholding tax is enabled.
