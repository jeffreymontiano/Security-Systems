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
//
// `recordType` is what makes an ops entry specific: one table holds every
// operational record, so the count has to be narrowed to the tab that owns the
// list. A table that holds only its own rows has no such discriminator and
// omits it — see url_category below, the first such entry.
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
  // Useful Links. Its own table, so no record_type discriminator — every row in
  // it holds a url_category and nothing else does.
  url_category:               { table: "useful_links", column: '"urlCategory"' },

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

  const { where, params } = scopeFor(usage, value);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ${usage.table} WHERE ${where}`, params
  );
  return { known: true, count: rows[0].count };
}

/**
 * The WHERE that isolates one list value inside its table, and the parameters
 * for it.
 *
 * Shared by the count above and the rename propagation in routes/meta.js so the
 * two can never disagree about which rows a value owns — a rename that moved a
 * different set of rows than the delete guard counted would be the exact
 * orphaning both exist to prevent.
 *
 * `recordType` is optional: ops_records holds every tab's rows in one table and
 * must be narrowed, a table of its own does not. Only identifiers from
 * LIST_USAGE reach the SQL; the value is always a parameter.
 */
function scopeFor(usage, value) {
  if (usage.recordType === undefined) {
    return { where: `${usage.column} = $1`, params: [value] };
  }
  return {
    where: `record_type = $1 AND ${usage.column} = $2`,
    params: [usage.recordType, value],
  };
}

module.exports = { LIST_USAGE, countUsage, scopeFor };
