const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, username, name, role }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

// Roles allowed to call the route. Admin can always do everything.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated." });
    if (req.user.role === "Admin" || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "You don't have permission to do that." });
  };
}

module.exports = { requireAuth, requireRole };
