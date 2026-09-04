# Broodiinnox Portal

A two-part web portal for the Afriinnox Broodiinnox smart brooding system:

- **Admin console** (`/admin`) — add devices, create farm-user accounts, assign
  devices to users, and record subscription payments.
- **Farm user portal** (`/user`) — live temperature, sensor, relay and
  incubation-progress monitoring/control for the device(s) assigned to that
  farmer, restyled in the Afriinnox green brand.

Both are gated behind a login screen (`/login`); which portal you land on is
decided automatically by your account's role.

## Communication Protocol

This portal uses **WebSockets** for real-time device communication instead of MQTT.
Each device connects via WebSocket, and the server broadcasts telemetry data to
all authenticated clients (admin and farm users) watching that device.

## Running locally

```bash
npm install
npm start
