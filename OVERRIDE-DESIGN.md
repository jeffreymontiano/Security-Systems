# Auditable payroll override layer — design

**Status: APPROVED IN SHAPE. Not built.** All four open questions answered and
folded in. Build proceeds in three reviewable stages — see section 11.

---

## 1. The central decision: overrides go INTO the engine, not on top of it

Q1 settled that an override sets the **assessed** amount and the cap / priority /
arrears ladder re-runs beneath it. That has one implementation consequence worth
stating first, because everything else follows from it.

The override is applied **inside `computeEmployeeLine()`**, not by a route
patching the result afterwards:

```js
computeEmployeeLine({ ..., overrides })     // Map of fieldName -> value
```

The engine computes each component as it does today, substitutes any overridden
component, and then runs its existing gross → cap ladder → net code unchanged.

The alternative — compute, then have the route adjust fields and re-derive the
totals — means re-implementing the priority/cap/arrears ladder outside the
engine. **That is precisely the defect in `PATCH /lines/:id`** (Known Gap 23):
a second copy of the money maths, in the least-reviewed place, already wrong.
There must stay exactly one implementation of that ladder.

## 2. Schema

```sql
CREATE TABLE IF NOT EXISTS payroll_line_overrides (
  id            SERIAL PRIMARY KEY,

  -- RESTRICT, not CASCADE: a labelled correction must never vanish with a
  -- period delete. See section 10.
  "periodId"    INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,

  -- SET NULL + snapshotted identity, mirroring payroll_lines exactly, so
  -- deleting an employee cannot be held hostage by this table and the record
  -- still says who it was about.
  "employeeId"   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  "employeeNo"   TEXT,
  "employeeName" TEXT NOT NULL,

  "fieldName"   TEXT NOT NULL,
  "fieldClass"  TEXT NOT NULL CHECK ("fieldClass" IN ('earning','deduction','statutory')),

  -- what the engine said WHEN THE OVERRIDE WAS MADE
  "computedValue" NUMERIC(12,2) NOT NULL,
  "overrideValue" NUMERIC(12,2) NOT NULL,
  reason          TEXT NOT NULL CHECK (btrim(reason) <> ''),
  "reasonCategory" TEXT,                       -- required for statutory (section 6)

  -- recompute reconciliation (section 4)
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','stale')),
  "staleComputedValue" NUMERIC(12,2),
  "staleDetectedAt"    TIMESTAMPTZ,
  "reconfirmedBy"      TEXT,
  "reconfirmedAt"      TIMESTAMPTZ,

  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE ("periodId", "employeeId", "fieldName")
);
```

Keyed by `(periodId, employeeId, fieldName)` — **not `lineId`**. A payroll line
is deleted and recreated by some flows; the employee is the stable identity.

`computedValue` is a **snapshot**, never updated except by explicit
re-confirmation. It is the evidence of what the engine said at the moment a
human chose to disagree with it. Section 4 depends on it staying frozen.

`reason` is `NOT NULL` with a non-empty CHECK, so a blank reason is refused by
the database, not merely by a form.

## 3. Which fields are overridable

**Components — overridable:**

| class | fields |
|---|---|
| earning | `regularPay`, `nightDiffPay`, `builtinOtPay`, `excessOtPay`, `holidayPremiumPay`, `holidayUnworkedPay`, `otherEarnings` |
| deduction | `lateUndertimeDeduction`, `otherDeductions` |
| statutory | `sssEe`, `sssEr`, `philhealthEe`, `philhealthEr`, `pagibigEe`, `pagibigEr`, `withholdingTax` |

**Derived — override-LOCKED, rejected at the API with 400:**

```
otPay        = builtinOtPay + excessOtPay
grossPay     = earnings − lateUndertimeDeduction
netPay       = grossPay − totalTaken
totalTaken, deductionsDeferred, arrearsClosing, arrearsOpening, arrearsRecovered
```

Locked rather than warned about. `netPay` is what disbursement reads
(`payroll.js:546`); an overridden net would pay a figure that reconciles to
nothing on its own payslip, and the payslip's entire credibility is that gross
minus the itemised deductions equals net. Override the components; the totals
fall out.

The whitelist is shared config, so the API, the UI and the engine cannot
disagree about what is overridable.

## 4. Recompute reconciliation

On every compute, per override, **before** substituting it:

1. Compute the field normally → `freshComputed`.
2. `freshComputed == computedValue` → the override still rests on the same base.
   Apply it. Nothing changes.
3. `freshComputed != computedValue` → the base moved underneath the override.
   - `status = 'stale'`, `staleComputedValue = freshComputed`, `staleDetectedAt = now()`
   - **Still apply the override**, and surface it loudly.

Principle 3 says do not auto-clear and do not silently keep. Applying satisfies
"do not auto-clear"; the flag plus the gate below is what makes it not silent.

**The gate: a period with any `stale` override cannot be Approved.**
`PATCH /periods/:id/approve` refuses with 409, naming the guards and fields.
This mirrors billing, where Issue is refused while any line holds a pending
review — the precedent already exists for "a workflow step is blocked until a
human resolves a flagged divergence".

Reconciling is an explicit act with three outcomes:

| action | effect |
|---|---|
| **Re-confirm** | `computedValue = staleComputedValue`, `status = 'active'`, stamps `reconfirmedBy/At`. The override now rests on the new base. |
| **Update** | new `overrideValue` + new reason; re-snapshots `computedValue`. |
| **Remove** | row deleted; the computed value takes effect on the next compute. |

The PhilHealth incident is the worked example: 19 lines where the computed base
moved from 2.14 to 427.50. Any override taken while the base was 2.14 would be
flagged rather than silently riding the corrected figure — exactly the class of
error this layer exists to prevent.

## 5. Effective-value resolution

```
effective(field) = override.overrideValue ?? computed(field)
```

Applied once, inside the engine. Every consumer — register, payslip PDF,
disbursement, any future remittance report — reads the stored `payroll_lines`
columns as it does today and needs no change. The stored column holds the
effective value; the override table holds the evidence and the computed
counterpart.

Deliberate: it keeps the override layer out of every read path, and means an
unmigrated or unaware consumer cannot accidentally pay the computed figure when
an override exists.

## 6. Statutory overrides are a distinct class

The seven statutory fields carry `fieldClass = 'statutory'` and differ in three
ways:

- **Stronger mandatory reason.** Minimum length plus a structured
  `reasonCategory` (*correction of a mis-assessed premium*, *retroactive
  adjustment*, *employee dispute*), not free text alone.
- **Flagged as COMPLIANCE EVENTS** in any remittance output, distinct from an
  allowance correction in the same period.
- **Both figures always retrievable per field.** `overrideValue` is what was
  **withheld / collected**; `computedValue` is what the engine **assessed**.
  Neither is ever destroyed, so a remittance report renders them side by side
  without reconstructing anything.

This extends a distinction the data model already carries. Measured on a real
line:

```
sssEe (stored) = withheld.sssEe   -> COLLECTED, after the gross cap    925
sssEr (stored) = sssEr            -> ASSESSED,  full monthly          1850
```

The engine's own comments say the split exists so *"remittance reports and the
payslip can show assessed-vs-collected honestly"*. No remittance report exists
yet; this makes sure one can be written later without a migration.

## 7. Permission — two gates, set the same for now

`permissions.js`, mirrored in `frontend/src/roles.js`:

```js
// Deliberately SEPARATE, so statutory overrides can be gated tighter than
// allowance corrections without a schema or API change later. Same membership
// today; the separation is what makes divergence cheap tomorrow.
const PAYROLL_OVERRIDE_ROLES           = ["Admin" /* TODO: + one senior finance/HR role */];
const PAYROLL_STATUTORY_OVERRIDE_ROLES = ["Admin" /* TODO: same, pending role-list review */];
```

Resolution is explicit, the way `hasAttendanceDelete()` is: the route asks which
class the field belongs to and checks the matching list. A statutory field
requires membership in **both**, so tightening the statutory list alone is a
one-line change.

**Deliberately TIGHTER than payroll-edit.** The four roles holding `edit` on
payroll do **not** get override by default. Same rationale the codebase already
states for `ATTENDANCE_EDIT_ROLES`: *"widening who may move money has to mean
editing this list, where it is visible in review."*

**Not** a matrix cell: the matrix has only view/add/edit/delete, and a per-user
grant from Manage Users would let this be handed out invisibly.

> **TODO before wiring:** the second role name, in both lists. Left blank on
> purpose — I will not guess which role holds it.

## 8. Audit

`payroll.js` currently writes **no** audit entries at all; this is its first.
Reuses the existing raw pattern (five call sites already), key
`PAY-{periodId}-{employeeId}`:

| action | recorded |
|---|---|
| `payroll_override_set` | field, class, computed, override, reason, category, actor |
| `payroll_override_updated` | old → new value, old → new reason |
| `payroll_override_removed` | field, the override withdrawn, computed value restored |
| `payroll_override_stale` | field, snapshot → fresh computed, detected at |
| `payroll_override_reconfirmed` | field, new base accepted, actor |

Audit writes swallow their own errors, per convention: the log must never fail
the action it records.

## 9. What the guard's payslip shows

- **Register + audit log**: the full mechanics — `computed → override · actor ·
  reason` — wherever an override exists, so divergence is never hidden from
  anyone reviewing payroll.
- **Payslip PDF**: the **effective figure only**, with a marker on the line and
  one footnote that it was adjusted. Not the computed-vs-override mechanics.

The guard receives a clean, final, honest document; the auditability lives where
auditors look. A payslip that argues with itself in front of the person being
paid answers a question they did not ask and raises three they cannot resolve.

## 10. Period deletion — overrides block it (option a)

**(a), enforced twice.** It matches how this codebase already protects evidence,
and (b) alone cannot survive a path that bypasses the route.

1. **`DELETE /periods/:id` refuses with 409** while the period holds any
   override, naming the count and the affected guards — the same shape as *"a
   level in use cannot be deleted"* in the asset taxonomy and the dropdown-value
   delete guard, and sitting alongside the two refusals that route already has
   (non-Admin, and Paid).
2. **The foreign key is `ON DELETE RESTRICT`**, so the database refuses too. The
   MDR precedent is explicit about this shape: immutability *"enforced twice:
   every write route refuses a non-Draft return, **and** database triggers
   refuse"*. A route check alone would let a future bulk operation or direct SQL
   discard labelled corrections silently — the one thing this layer exists to
   prevent.

The only way past it is **removal-with-reason**, which writes
`payroll_override_removed` to the audit log. The record survives by
construction, whichever way the admin proceeds.

**Employee deletion is treated differently, deliberately.** `employeeId` is
`ON DELETE SET NULL` with `employeeNo`/`employeeName` snapshotted, mirroring
`payroll_lines`. RESTRICT there would let this table hold the 201 File hostage —
the exact failure the MDR design calls out. The snapshot means the record still
says who it was about.

> **Known nuance, accepted:** with `employeeId` NULL, `UNIQUE (periodId,
> employeeId, fieldName)` stops constraining that row, because Postgres treats
> NULLs as distinct. The row is historical at that point — no future compute
> resolves against a deleted employee — and `payroll_lines` already carries the
> identical exposure via `UNIQUE (periodId, employeeId)`. Consistent, not novel.

## 11. Build order — three reviewable stages

**Stage (i) — the money-path core.** Schema, the `overrides` map into
`computeEmployeeLine()`, and the one-ladder substitution. Tests must prove an
override **re-runs the cap / priority / arrears ladder**: specifically on a line
where deductions exceed gross so the deferral path is exercised, and on a line
recovering prior arrears. **Review gate before anything else is built.**

**Stage (ii) — reconciliation.** Stale detection on recompute, the re-confirm /
update / remove actions, and the Approve-blocking 409.

**Stage (iii) — surface.** Permission wiring, the register UI, the payslip
marker and footnote, and the audit writes.

## 12. This feature retires Known Gap 23

`PATCH /lines/:id` hand-rolls net pay, omitting arrears and the gross cap. Once
stage (i) lands, that endpoint is **rewritten to route through the same engine
overrides mechanism** rather than restating the formula: adjusting Other
Deductions becomes an override on `otherDeductions`, and the engine re-derives
net pay through its own ladder.

That is the fix for Gap 23, and it is why the override layer is not built on top
of that endpoint. Do not close Gap 23 until this linkage is done.
