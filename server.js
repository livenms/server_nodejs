import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";

import { requireAuth, requireAdmin } from "./lib/auth.js";
import * as db from "./lib/db.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render sits behind a proxy that terminates TLS - trust it so secure
// cookies work correctly in production.
app.set("trust proxy", 1);

app.use(express.json());

app.use(
  session({
    name: "broodiinnox.sid",
    secret: process.env.SESSION_SECRET || "broodiinnox-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

// Publicly servable static assets (no secrets live here - API calls are
// what actually require an authenticated session).
app.use("/assets", express.static(path.join(__dirname, "public/assets")));
app.use("/admin-assets", express.static(path.join(__dirname, "public/admin-assets")));
app.use("/user-assets", express.static(path.join(__dirname, "public/user-assets")));

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    name: u.name,
    farmName: u.farmName || "",
    phone: u.phone || "",
    email: u.email || "",
    active: u.active,
    mustChangePassword: !!u.mustChangePassword,
  };
}

function publicDevice(d) {
  const status = db.subscriptionStatus(d.id);
  const owner = d.ownerId ? db.findUserById(d.ownerId) : null;
  return {
    id: d.id,
    deviceId: d.deviceId,
    name: d.name,
    mqttBroker: d.mqttBroker,
    topicPrefix: d.topicPrefix || "BROODIINNOX",
    animal: d.animal,
    location: d.location,
    ownerId: d.ownerId,
    ownerName: owner ? owner.name : null,
    ownerUsername: owner ? owner.username : null,
    subscription: status,
  };
}

// ------------------------------------------------------------------
// Page routes
// ------------------------------------------------------------------
app.get("/", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  return res.redirect(req.session.role === "admin" ? "/admin" : "/user");
});

app.get("/login", (req, res) => {
  if (req.session.userId) {
    return res.redirect(req.session.role === "admin" ? "/admin" : "/user");
  }
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get(["/admin", "/admin/"], requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin.html"));
});

app.get(["/user", "/user/"], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user.html"));
});

// ------------------------------------------------------------------
// Auth API
// ------------------------------------------------------------------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  const user = db.verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.findUserById(req.session.userId);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

app.post("/api/me/password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  const ok = db.verifyLogin(user.username, currentPassword || "");
  if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
  db.setPassword(user.id, newPassword);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// User (farm) API - scoped to the logged-in user's own devices
// ------------------------------------------------------------------
app.get("/api/me/devices", requireAuth, (req, res) => {
  const devices =
    req.session.role === "admin" ? db.listDevices() : db.devicesForUser(req.session.userId);
  res.json({ devices: devices.map(publicDevice) });
});

// ------------------------------------------------------------------
// Admin API
// ------------------------------------------------------------------
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json(db.adminStats());
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ users: db.listUsers().map(publicUser) });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  try {
    const { username, password, name, farmName, phone, email } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const user = db.createUser({ username, password, name, farmName, phone, email });
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  try {
    const user = db.updateUser(req.params.id, req.body || {});
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/admin/users/:id/reset-password", requireAdmin, (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }
    db.setPassword(req.params.id, newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/devices", requireAdmin, (req, res) => {
  res.json({ devices: db.listDevices().map(publicDevice) });
});

app.post("/api/admin/devices", requireAdmin, (req, res) => {
  try {
    const device = db.createDevice(req.body || {});
    res.json({ device: publicDevice(device) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/admin/devices/:id", requireAdmin, (req, res) => {
  try {
    const device = db.updateDevice(req.params.id, req.body || {});
    res.json({ device: publicDevice(device) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/admin/devices/:id", requireAdmin, (req, res) => {
  db.deleteDevice(req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/payments", requireAdmin, (req, res) => {
  const payments = db.listPayments().map((p) => {
    const device = db.findDevice(p.deviceId);
    return {
      ...p,
      deviceName: device ? device.name : "Unknown device",
      deviceExternalId: device ? device.deviceId : "",
    };
  });
  res.json({ payments });
});

app.post("/api/admin/payments", requireAdmin, (req, res) => {
  try {
    const payment = db.createPayment(req.body || {});
    res.json({ payment });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/admin/payments/:id", requireAdmin, (req, res) => {
  db.deletePayment(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Broodiinnox Portal running on port " + PORT);
});
