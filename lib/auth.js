export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Please log in." });
  }
  return res.redirect("/login");
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "admin") {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  return res.redirect("/login");
}
