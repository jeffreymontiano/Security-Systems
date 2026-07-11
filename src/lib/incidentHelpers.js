const { pool } = require("../db");

async function fullIncident(id) {
  const inc = (await pool.query("SELECT * FROM incidents WHERE id = $1", [id])).rows[0];
  if (!inc) return null;
  inc.evidence = (await pool.query("SELECT * FROM evidence WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.witnesses = (await pool.query("SELECT * FROM witnesses WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.actions = (await pool.query("SELECT * FROM actions WHERE incident_id = $1 ORDER BY id", [id])).rows;
  inc.attachments = (await pool.query(
    "SELECT id, filename, mimetype, size, uploaded_by, uploaded_at FROM attachments WHERE incident_id = $1 ORDER BY id", [id]
  )).rows;
  return inc;
}

// Uses a Postgres sequence (see db.js) so concurrent submissions - including
// from the public, unauthenticated report form - can never collide on the
// same incident id.
async function nextIncidentId() {
  const { rows } = await pool.query("SELECT nextval('incident_id_seq') AS n");
  return "INC-" + String(rows[0].n).padStart(4, "0");
}

async function log(incidentId, username, action, detail) {
  await pool.query(
    "INSERT INTO audit_log (incident_id, username, action, detail) VALUES ($1,$2,$3,$4)",
    [incidentId, username, action, detail || null]
  );
}

module.exports = { fullIncident, nextIncidentId, log };
