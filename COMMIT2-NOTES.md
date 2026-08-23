# Night differential — the paid-minutes rule

Companion record for the change that made night differential attach to PAID
minutes only. The rule itself is documented in `CLAUDE.md` (*Payroll detail*);
this file holds what does not belong there: the accepted defect the work
surfaced, and where the verification lives.

## Known item — NOT fixed here, accepted deliberately

**A shift's overtime is invisible past the 2-hour pairing window.**

A punch-out more than 2 hours after the scheduled end is not paired to the duty
at all (`attendance-reports.js`, `tailPad`; a straight duty gets 6 hours). The
day then reads **No time-out**: no built-in OT, no excess OT, no night
differential, and billing holds the day and credits the client. So a guard
rostered 06:00-18:00 who genuinely works until 22:30 loses the whole day rather
than earning four hours of overtime.

This is why a day shift ending at 18:00 can never produce night-differential-
bearing overtime in practice: reaching 22:00 needs four hours of overtime, and
the punch is discarded long before the premium is a question. The oracle's row 3
(day shift, approved OT to 23:00, 60 minutes of premium) is therefore a valid
**pay-rule** oracle that cannot currently arise **end-to-end** on that shift.

The pairing window BOUNDS this; it does not cause it. Widening or replacing it
moves which punches belong to which duty, and therefore moves billing, so it
needs its own change with its own diff. Recorded, not fixed.

## Verification

All in the session scratchpad, not shipped:

| | |
|---|---|
| `night-oracle.js` | the seven authoritative rows — six supplied by the agency plus one added to separate scheduled-∩-worked from pure-scheduled. Asserts minutes AND pesos. |
| `night-diff-audit.js` | read-only production audit; classifies every night-diff row and predicts its post-fix value. `--json` for machines. **Pre-deploy only** — once the fix is live its "NIGHT now" column describes the old rule and its drift check inverts. |
| `night-fixture.js` / `night-fixture-cases.js` | six seeded shapes on dev |
| `night-audit-verify.js` | machine-checks the audit against hand-derived values, including that every minute it removes is accounted for by a named interval |

The one row that separates the two candidate rules is a night shift whose guard
arrives at 23:30: scheduled-∩-worked gives **390**, pure-scheduled gives **480**
— paying a premium for 90 minutes before the guard clocked in.
