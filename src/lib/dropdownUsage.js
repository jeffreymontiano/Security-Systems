/**
 * Where each configurable list's values are actually STORED.
 *
 * This mapping existed nowhere before: no router references a list key, and the
 * knowledge lived only in per-page frontend config. It is also not mechanical —
 * `training_type` lands in a column called `courseName`, not `trainingType` —
 * so only entries VERIFIED against the code are listed here.
 *
 * An unmapped list is reported as UNKNOWN rather than guessed. A guard that
 * checks the wrong column is worse than no guard: it reads as protection while
 * protecting nothing. Adding a list here means verifying its column first.
 *
 * Why this file exists: Manage Lists could delete a value that records were
 * using. Nothing stopped it and nothing recorded it, so every row holding that
 * value was orphaned — it then rendered as the dropdown's FIRST option rather
 * than as itself, which is how a "Complete" that was not Complete reached the
 * dashboard. The asset taxonomy already has this rule ("a level in use cannot
 * be deleted — deactivate it instead"); the flat lists never did.
 */

// Every ops list stores its value on ops_records, distinguished by record_type.
const opsStatus = (recordType) => ({ table: "ops_records", column: "status", recordType });
const opsValue = (recordType) => ({ table: "ops_records", column: "value", recordType });

const LIST_USAGE = {
  // Security Operations Dashboard
  deployment_status:          opsStatus("guard_deployment"),
  site_condition:             opsStatus("site_status"),
  site_manning_status:        opsStatus("site_manning"),
  video_patrol_status:        opsStatus("patrol_video"),
  post_type:                  opsValue("patrol_video"),
  // Deployment & Post Management
  post_orders_status:         opsStatus("post_orders"),
  deployment_planning_status: opsStatus("deployment_planning"),
  reliever_management_status: opsStatus("reliever_management"),
  vacancy_tracking_status:    opsStatus("vacancy_tracking"),
  shift_assignments_status:   opsStatus("shift_assignments"),
  shift_assignments_shift:    opsValue("shift_assignments"),

  // NOT MAPPED, deliberately — verify the column before adding one. Several are
  // non-obvious: violation_type -> disciplinary_cases."violationType", and
  // training_type -> the training record's `courseName`.
  //   violation_type, penalty_type, promotion_recommendation, training_type,
  //   attendance_status, exam_result, compliance_area, corrective_action_status,
  //   position_title, background_check_status, license_verification_status,
  //   medical_exam_status, employment_status, lesp_category
};

/**
 * How many records currently hold `value` from `listKey`.
 *
 * Returns `{ known: false }` for a list whose storage has not been verified, so
 * the caller can say "cannot check" instead of "not in use" — the two must
 * never be confused.
 *
 * Only identifiers from the table above reach the SQL; the value is always a
 * parameter.
 */
async function countUsage(pool, listKey, value) {
  const usage = LIST_USAGE[listKey];
  if (!usage) return { known: false, count: 0 };

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM ${usage.table}
      WHERE record_type = $1 AND ${usage.column} = $2`,
    [usage.recordType, value]
  );
  return { known: true, count: rows[0].count };
}

module.exports = { LIST_USAGE, countUsage };
