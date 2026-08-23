-- ===========================================================================
-- NIGHT-DIFFERENTIAL RAW INPUT DUMP  --  period 2026-08-16 .. 2026-08-18
--
-- READ-ONLY. One SELECT, no writes, no temp objects, no settings changed.
--
-- Deliberately contains NO night-window arithmetic. It dumps the raw inputs
-- only; the 22:00-06:00 rule is applied by the engine, so this query cannot
-- disagree with it. The one derived thing here is the scheduled window, used
-- ONLY to decide which punches are near the duty -- the raw startTime/endTime/
-- crossesMidnight columns are dumped beside it so the derivation is checkable.
--
-- Does not reference attendance_records."deletedAt": the soft-delete migration
-- is not deployed to production.
-- ===========================================================================
WITH per AS (
  SELECT id
    FROM payroll_periods
   WHERE "periodStart" = DATE '2026-08-16'
     AND "periodEnd"   = DATE '2026-08-18'
),
nd AS (   -- every duty row currently carrying night differential
  SELECT l."employeeId",
         l."employeeName",
         d."dutyDate",
         d."nightMinutes",
         d."nightOtMinutes",
         d."nightMinutes" + d."nightOtMinutes" AS night_min_now,
         d."nightDiffPay"                      AS night_pay_now,
         d."regularMinutes",
         d."otMinutes",
         d."dayType"
    FROM payroll_line_days d
    JOIN payroll_lines     l ON l.id = d."lineId"
   WHERE l."periodId" = (SELECT id FROM per)
     AND (d."nightMinutes" + d."nightOtMinutes") > 0
),
sched AS (
  SELECT nd.*,
         e."employeeNo",
         e."dailyRate",
         a."shiftName",
         a."shiftKind",
         a."startTime",
         a."endTime",
         a."crossesMidnight",
         a."startTime2",
         a."endTime2",
         (SELECT count(*)
            FROM shift_assignments x
           WHERE x."employeeId" = nd."employeeId"
             AND x."dutyDate"   = nd."dutyDate")                    AS sched_rows,
         CASE WHEN a."startTime" IS NOT NULL
              THEN (nd."dutyDate" + a."startTime"::time) AT TIME ZONE 'Asia/Manila'
         END                                                        AS sched_start,
         CASE WHEN a."endTime" IS NOT NULL
              THEN (nd."dutyDate" + a."endTime"::time
                    + CASE WHEN a."crossesMidnight"
                           THEN interval '1 day' ELSE interval '0' END)
                   AT TIME ZONE 'Asia/Manila'
         END                                                        AS sched_end
    FROM nd
    JOIN employees e ON e.id = nd."employeeId"
    LEFT JOIN LATERAL (
      SELECT sa."shiftName", sa."shiftKind", sa."startTime", sa."endTime",
             sa."crossesMidnight", sa."startTime2", sa."endTime2"
        FROM shift_assignments sa
       WHERE sa."employeeId" = nd."employeeId"
         AND sa."dutyDate"   = nd."dutyDate"
       ORDER BY sa.id
       LIMIT 1
    ) a ON true
),
anchored AS (
  SELECT s.*,
         COALESCE(s.sched_start,
                  (s."dutyDate" + time '00:00') AT TIME ZONE 'Asia/Manila') AS in_anchor,
         COALESCE(s.sched_end,
                  (s."dutyDate" + time '23:59') AT TIME ZONE 'Asia/Manila') AS out_anchor
    FROM sched s
)
SELECT
  a."employeeNo"                                                    AS employee_no,
  a."employeeName"                                                  AS guard,
  to_char(a."dutyDate", 'YYYY-MM-DD')                               AS duty_date,
  a."dayType"                                                       AS day_type,
  a."dailyRate"                                                     AS daily_rate,
  a."shiftName"                                                     AS shift_label,
  a."shiftKind"                                                     AS shift_kind,
  a."startTime"                                                     AS sched_start_time,
  a."endTime"                                                       AS sched_end_time,
  a."crossesMidnight"                                               AS crosses_midnight,
  a."startTime2"                                                    AS broken_start2,
  a."endTime2"                                                      AS broken_end2,
  a.sched_rows,
  to_char(a.sched_start AT TIME ZONE 'Asia/Manila', 'MM-DD HH24:MI') AS sched_start_ph,
  to_char(a.sched_end   AT TIME ZONE 'Asia/Manila', 'MM-DD HH24:MI') AS sched_end_ph,
  to_char(pin."punchAt" AT TIME ZONE 'Asia/Manila', 'MM-DD HH24:MI') AS punch_in_ph,
  to_char(pout."punchAt" AT TIME ZONE 'Asia/Manila', 'MM-DD HH24:MI') AS punch_out_ph,
  pin.n_candidates                                                  AS in_candidates,
  pout.n_candidates                                                 AS out_candidates,
  COALESCE(ot.approved_min, 0)                                      AS approved_ot_min,
  a."regularMinutes"                                                AS reg_min_now,
  a."otMinutes"                                                     AS ot_min_now,
  a."nightMinutes"                                                  AS night_reg_min_now,
  a."nightOtMinutes"                                                AS night_ot_min_now,
  a.night_min_now,
  a.night_pay_now
FROM anchored a

-- The IN punch nearest the scheduled start, and how many were in contention.
LEFT JOIN LATERAL (
  SELECT r."punchAt",
         count(*) OVER ()                                           AS n_candidates
    FROM attendance_records r
   WHERE r."guardName"  = a."employeeName"
     AND r."punchType"  = 'IN'
     AND r."punchAt" >= a.in_anchor - interval '6 hours'
     AND r."punchAt" <= a.in_anchor + interval '8 hours'
   ORDER BY abs(extract(epoch FROM (r."punchAt" - a.in_anchor)))
   LIMIT 1
) pin ON true

-- The OUT punch nearest the scheduled end. The window is generous on purpose:
-- it is a DUMP, not the engine's pairing, and a punch shown here that the
-- engine would not have paired is visible rather than hidden.
LEFT JOIN LATERAL (
  SELECT r."punchAt",
         count(*) OVER ()                                           AS n_candidates
    FROM attendance_records r
   WHERE r."guardName"  = a."employeeName"
     AND r."punchType"  = 'OUT'
     AND r."punchAt" >= a.out_anchor - interval '8 hours'
     AND r."punchAt" <= a.out_anchor + interval '8 hours'
   ORDER BY abs(extract(epoch FROM (r."punchAt" - a.out_anchor)))
   LIMIT 1
) pout ON true

-- Approved overtime for that duty date. APPROVED only: that is what the engine
-- pays, and therefore the only overtime that can carry a night premium.
LEFT JOIN LATERAL (
  SELECT sum(COALESCE(o."approvedMinutes", 0))::int AS approved_min
    FROM overtime_records o
   WHERE o."employeeId" = a."employeeId"
     AND o."dutyDate"   = a."dutyDate"
     AND o.status       = 'Approved'
) ot ON true

ORDER BY a."employeeName", a."dutyDate";
