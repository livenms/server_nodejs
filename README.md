# Broodiinnox Portal

A two-part web portal for the Afriinnox Broodiinnox smart brooding system:

- **Admin console** (`/admin`) — add devices, create farm-user accounts, assign
  devices to users, and record subscription payments.
- **Farm user portal** (`/user`) — live temperature, sensor, relay and
  incubation-progress monitoring/control for the device(s) assigned to that
  farmer, restyled in the Afriinnox green brand.

Both are gated behind a login screen (`/login`); which portal you land on is
decided automatically by your account's role.

## Running locally

```bash
npm install
npm start
```

The server prints a one-time default admin login on first boot:

```
username: admin
password: Afriinnox@2026
```

Sign in and change it immediately from **My Account → Change password**
(admin console) or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars before
first boot to skip the default entirely.

## How it's wired together

- **Auth** — `express-session` + `bcryptjs`. Sessions are server-side cookies;
  the admin API (`/api/admin/*`) and the scoped user API (`/api/me/*`) both
  check the session before doing anything.
- **Data** — SQLite via `better-sqlite3`, stored as a single file at
  `data/broodiinnox.db` (plus its `-wal`/`-shm` companion files), created
  automatically on first boot. Real relational tables (`users`, `devices`,
  `payments`) with a foreign key from devices→owner and payments→device, so
  deleting a user un-assigns their devices and deleting a device removes its
  payment history automatically. `lib/db.js` is the only file that talks to
  the database — swap it for Postgres/MySQL later without touching routes.
- **Live device data** — unchanged from the original dashboard: the browser
  connects directly to the public MQTT broker over WebSockets
  (`wss://<broker>:8884/mqtt`) and subscribes to
  `BROODIINNOX/<DEVICE_ID>/data` and `.../status`, matching the ESP32
  firmware exactly. Controls (relay, setpoints, sensor toggles, presets,
  factory reset) publish to `.../control/...` the same way.
- **Payments & locking** — payments are recorded by the admin against a
  device and have a paid-on date + period, from which a due date and status
  (`paid` / `due_soon` / `overdue`) are derived automatically. The device's
  *actual* lock state shown in both portals comes live from the firmware's
  `device_locked` field in its MQTT payload — the portal doesn't guess.

## Deploying to Render

`render.yaml` is already set up for a free Node web service with a small
persistent disk mounted at `data/` so accounts/devices/payments survive
restarts. Push this repo, connect it on Render, and set:

- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your real admin login (optional but
  recommended instead of relying on the printed default)
- `SESSION_SECRET` — Render will auto-generate this if you use `render.yaml`

## Project layout

```
server.js              Express app: sessions, page routing, REST API
lib/db.js               JSON-file data layer (users, devices, payments)
lib/auth.js              requireAuth / requireAdmin middleware
views/login.html          Shared sign-in page
views/admin.html          Admin console shell
views/user.html            Farm user portal shell
public/assets/            Shared design system (theme.css) + helpers (common.js) + logo
public/admin-assets/       Admin console logic/styles
public/user-assets/        Farm portal logic/styles (gauge, sensors, controls)
```
