import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "broodiinnox.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    farmName TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    mustChangePassword INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    deviceId TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    mqttBroker TEXT NOT NULL DEFAULT 'broker.hivemq.com',
    topicPrefix TEXT NOT NULL DEFAULT 'BROODIINNOX',
    animal TEXT NOT NULL DEFAULT 'Chicken',
    location TEXT DEFAULT '',
    ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'RWF',
    periodDays INTEGER NOT NULL DEFAULT 30,
    paidOn TEXT NOT NULL,
    dueDate TEXT NOT NULL,
    note TEXT DEFAULT '',
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(ownerId);
  CREATE INDEX IF NOT EXISTS idx_payments_device ON payments(deviceId);
`);

function id() {
  return crypto.randomUUID();
}

function toBool(v) {
  return !!v;
}

function rowToUser(row) {
  if (!row) return undefined;
  return { ...row, active: toBool(row.active), mustChangePassword: toBool(row.mustChangePassword) };
}

// ------------------------------------------------------------------
// Seed a default administrator account on first boot. Credentials can
// be overridden with env vars so the same default password is never
// left in place on a real deployment.
// ------------------------------------------------------------------
function seedAdmin() {
  const existing = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (existing) return;

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "Afriinnox@2026";

  db.prepare(
    `INSERT INTO users (id, username, passwordHash, role, name, email, phone, active, mustChangePassword, createdAt)
     VALUES (@id, @username, @passwordHash, 'admin', @name, '', '', 1, @mustChangePassword, @createdAt)`
  ).run({
    id: id(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    name: "Afriinnox Administrator",
    mustChangePassword: process.env.ADMIN_PASSWORD ? 0 : 1,
    createdAt: new Date().toISOString(),
  });

  if (!process.env.ADMIN_PASSWORD) {
    console.log("========================================================");
    console.log(" First run: a default admin account was created.");
    console.log("   username: " + username);
    console.log("   password: " + password);
    console.log(" Please log in and change this password immediately, or");
    console.log(" set ADMIN_USERNAME / ADMIN_PASSWORD env vars and redeploy.");
    console.log("========================================================");
  }
}
seedAdmin();

// ------------------------------------------------------------------
// Users
// ------------------------------------------------------------------
export function findUserByUsername(username) {
  const row = db
    .prepare(`SELECT * FROM users WHERE lower(username) = lower(?)`)
    .get(String(username || ""));
  return rowToUser(row);
}
export function findUserById(userId) {
  return rowToUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId));
}
export function listUsers() {
  return db.prepare(`SELECT * FROM users WHERE role = 'user' ORDER BY createdAt DESC`).all().map(rowToUser);
}
export function createUser({ username, password, name, farmName, phone, email }) {
  if (findUserByUsername(username)) {
    throw new Error("That username is already taken.");
  }
  const user = {
    id: id(),
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: "user",
    name: name || username,
    farmName: farmName || "",
    phone: phone || "",
    email: email || "",
    active: 1,
    mustChangePassword: 1,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO users (id, username, passwordHash, role, name, farmName, phone, email, active, mustChangePassword, createdAt)
     VALUES (@id, @username, @passwordHash, @role, @name, @farmName, @phone, @email, @active, @mustChangePassword, @createdAt)`
  ).run(user);
  return rowToUser(user);
}
export function updateUser(userId, patch) {
  const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!existing) throw new Error("User not found.");
  const allowed = ["name", "farmName", "phone", "email", "active"];
  const next = { ...existing };
  for (const k of allowed) if (k in patch) next[k] = k === "active" ? (patch[k] ? 1 : 0) : patch[k];
  db.prepare(
    `UPDATE users SET name=@name, farmName=@farmName, phone=@phone, email=@email, active=@active WHERE id=@id`
  ).run(next);
  return findUserById(userId);
}
export function setPassword(userId, newPassword) {
  const existing = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  if (!existing) throw new Error("User not found.");
  db.prepare(`UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?`).run(
    bcrypt.hashSync(newPassword, 10),
    userId
  );
  return findUserById(userId);
}
export function deleteUser(userId) {
  db.prepare(`UPDATE devices SET ownerId = NULL WHERE ownerId = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}
export function verifyLogin(username, password) {
  const u = findUserByUsername(username);
  if (!u || !u.active) return null;
  if (!bcrypt.compareSync(password, u.passwordHash)) return null;
  return u;
}

// ------------------------------------------------------------------
// Devices
// ------------------------------------------------------------------
export function listDevices() {
  return db.prepare(`SELECT * FROM devices ORDER BY createdAt DESC`).all();
}
export function findDevice(deviceRecordId) {
  return db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceRecordId);
}
export function createDevice({ deviceId, name, mqttBroker, topicPrefix, animal, location, ownerId }) {
  const clash = db
    .prepare(`SELECT id FROM devices WHERE lower(deviceId) = lower(?)`)
    .get(deviceId);
  if (clash) throw new Error("A device with that Device ID already exists.");

  const device = {
    id: id(),
    deviceId: deviceId.trim(),
    name: name || deviceId.trim(),
    mqttBroker: mqttBroker || "broker.hivemq.com",
    // MQTT topics are built as "<topicPrefix>/<deviceId>/...". Different
    // firmware builds have shipped with different casing here
    // (e.g. "BROODIINNOX" vs "broodinnox"), so this is per-device rather
    // than assumed.
    topicPrefix: (topicPrefix || "BROODIINNOX").trim(),
    animal: animal || "Chicken",
    location: location || "",
    ownerId: ownerId || null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO devices (id, deviceId, name, mqttBroker, topicPrefix, animal, location, ownerId, createdAt)
     VALUES (@id, @deviceId, @name, @mqttBroker, @topicPrefix, @animal, @location, @ownerId, @createdAt)`
  ).run(device);
  return device;
}
export function updateDevice(deviceRecordId, patch) {
  const existing = findDevice(deviceRecordId);
  if (!existing) throw new Error("Device not found.");
  const allowed = ["name", "mqttBroker", "topicPrefix", "animal", "location", "ownerId"];
  const next = { ...existing };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  db.prepare(
    `UPDATE devices SET name=@name, mqttBroker=@mqttBroker, topicPrefix=@topicPrefix,
       animal=@animal, location=@location, ownerId=@ownerId WHERE id=@id`
  ).run(next);
  return findDevice(deviceRecordId);
}
export function deleteDevice(deviceRecordId) {
  db.prepare(`DELETE FROM devices WHERE id = ?`).run(deviceRecordId); // payments cascade
}
export function devicesForUser(userId) {
  return db.prepare(`SELECT * FROM devices WHERE ownerId = ? ORDER BY createdAt DESC`).all(userId);
}

// ------------------------------------------------------------------
// Payments / subscription status
// ------------------------------------------------------------------
export function listPayments() {
  return db.prepare(`SELECT * FROM payments ORDER BY paidOn DESC`).all();
}
export function paymentsForDevice(deviceRecordId) {
  return db
    .prepare(`SELECT * FROM payments WHERE deviceId = ? ORDER BY paidOn DESC`)
    .all(deviceRecordId);
}
export function createPayment({ deviceId, amount, currency, periodDays, paidOn, note }) {
  const device = findDevice(deviceId);
  if (!device) throw new Error("Device not found.");
  const paid = paidOn ? new Date(paidOn) : new Date();
  const days = Number(periodDays) > 0 ? Number(periodDays) : 30;
  const due = new Date(paid.getTime() + days * 24 * 60 * 60 * 1000);
  const payment = {
    id: id(),
    deviceId,
    amount: Number(amount) || 0,
    currency: currency || "RWF",
    periodDays: days,
    paidOn: paid.toISOString(),
    dueDate: due.toISOString(),
    note: note || "",
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO payments (id, deviceId, amount, currency, periodDays, paidOn, dueDate, note, createdAt)
     VALUES (@id, @deviceId, @amount, @currency, @periodDays, @paidOn, @dueDate, @note, @createdAt)`
  ).run(payment);
  return payment;
}
export function deletePayment(paymentId) {
  db.prepare(`DELETE FROM payments WHERE id = ?`).run(paymentId);
}

// Latest payment record for a device, plus a derived status.
export function subscriptionStatus(deviceRecordId) {
  const history = paymentsForDevice(deviceRecordId);
  const latest = history[0] || null;
  if (!latest) {
    return { status: "no_payment", dueDate: null, lastPaidOn: null, latest: null, history };
  }
  const due = new Date(latest.dueDate);
  const now = new Date();
  const msLeft = due.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  let status = "paid";
  if (daysLeft < 0) status = "overdue";
  else if (daysLeft <= 7) status = "due_soon";
  return {
    status,
    daysLeft,
    dueDate: latest.dueDate,
    lastPaidOn: latest.paidOn,
    latest,
    history,
  };
}

export function adminStats() {
  const devices = listDevices();
  const users = listUsers();
  const now = new Date();
  let overdue = 0,
    dueSoon = 0,
    unassigned = 0;
  let revenueThisMonth = 0;

  devices.forEach((d) => {
    if (!d.ownerId) unassigned++;
    const s = subscriptionStatus(d.id);
    if (s.status === "overdue") overdue++;
    if (s.status === "due_soon") dueSoon++;
  });

  db.prepare(`SELECT amount, paidOn FROM payments`)
    .all()
    .forEach((p) => {
      const paid = new Date(p.paidOn);
      if (paid.getMonth() === now.getMonth() && paid.getFullYear() === now.getFullYear()) {
        revenueThisMonth += Number(p.amount) || 0;
      }
    });

  return {
    totalUsers: users.length,
    totalDevices: devices.length,
    unassignedDevices: unassigned,
    overdue,
    dueSoon,
    revenueThisMonth,
  };
}
