const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./fingerprint.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT UNIQUE,
    ip TEXT,
    lastSeen DATETIME,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    userName TEXT,
    userId INTEGER,
    granted BOOLEAN,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deviceId) REFERENCES devices (deviceId)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    userId INTEGER,
    userName TEXT,
    userPhone TEXT,
    enrolledAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deviceId) REFERENCES devices (deviceId)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    type TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deviceId) REFERENCES devices (deviceId)
  )`);
});

// Store active device commands
const deviceCommands = new Map();

// Webhook endpoints for ESP32 to send data
app.post('/api/webhook/heartbeat', (req, res) => {
  const { deviceId, type, uptime, wifi, ip } = req.body;
  
  // Update device status
  db.run(
    `INSERT OR REPLACE INTO devices (deviceId, ip, lastSeen, status) 
     VALUES (?, ?, datetime('now'), ?)`,
    [deviceId, ip, wifi ? 'online' : 'offline'],
    function(err) {
      if (err) {
        console.error('Error updating device:', err);
      }
    }
  );

  io.emit('heartbeat', { deviceId, uptime, wifi, ip, timestamp: new Date() });
  res.status(200).json({ success: true });
});

app.post('/api/webhook/status', (req, res) => {
  const { deviceId, users, totalUsers, maxUsers, sensor, enrolling } = req.body;
  
  // Update users for this device
  db.run('DELETE FROM users WHERE deviceId = ?', [deviceId], (err) => {
    if (err) console.error('Error clearing users:', err);
    
    if (users && Array.isArray(users)) {
      users.forEach(user => {
        db.run(
          `INSERT INTO users (deviceId, userId, userName, userPhone) VALUES (?, ?, ?, ?)`,
          [deviceId, user.id, user.name, user.phone || '']
        );
      });
    }
  });

  io.emit('status', req.body);
  res.status(200).json({ success: true });
});

app.post('/api/webhook/access', (req, res) => {
  const { deviceId, name, id, granted, timestamp } = req.body;
  
  db.run(
    `INSERT INTO access_logs (deviceId, userName, userId, granted) VALUES (?, ?, ?, ?)`,
    [deviceId, name, id, granted]
  );

  io.emit('access', {
    deviceId,
    name,
    id,
    granted,
    timestamp: new Date(),
    type: granted ? 'success' : 'error'
  });

  res.status(200).json({ success: true });
});

app.post('/api/webhook/enrollment', (req, res) => {
  const { deviceId, status, step, id, name, enrolling } = req.body;
  
  io.emit('enrollment', {
    deviceId,
    status,
    step,
    id,
    name,
    enrolling,
    timestamp: new Date()
  });

  // Log enrollment activity
  db.run(
    `INSERT INTO system_logs (deviceId, type, message) VALUES (?, ?, ?)`,
    [deviceId, 'enrollment', status]
  );

  res.status(200).json({ success: true });
});

app.post('/api/webhook/device-event', (req, res) => {
  const { deviceId, action, id, name } = req.body;
  
  io.emit('device-event', {
    deviceId,
    action,
    id,
    name,
    timestamp: new Date()
  });

  db.run(
    `INSERT INTO system_logs (deviceId, type, message) VALUES (?, ?, ?)`,
    [deviceId, 'system', `${action}: ${name || id}`]
  );

  res.status(200).json({ success: true });
});

// Command endpoints for dashboard to send commands to ESP32
app.post('/api/command/enroll', (req, res) => {
  const { deviceId, id, name, phone } = req.body;
  
  if (!deviceId || !id || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Store command for device to pick up
  deviceCommands.set(deviceId, {
    type: 'enroll',
    id,
    name,
    phone: phone || ''
  });

  io.emit('command-sent', { deviceId, type: 'enroll', id, name });
  res.json({ success: true, message: 'Enrollment command sent' });
});

app.post('/api/command/delete', (req, res) => {
  const { deviceId, id } = req.body;
  
  if (!deviceId || !id) {
    return res.status(400).json({ error: 'Missing deviceId or id' });
  }

  deviceCommands.set(deviceId, {
    type: 'delete',
    id
  });

  io.emit('command-sent', { deviceId, type: 'delete', id });
  res.json({ success: true, message: 'Delete command sent' });
});

app.post('/api/command/clear', (req, res) => {
  const { deviceId } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing deviceId' });
  }

  deviceCommands.set(deviceId, {
    type: 'clear'
  });

  io.emit('command-sent', { deviceId, type: 'clear' });
  res.json({ success: true, message: 'Clear all command sent' });
});

app.post('/api/command/getstatus', (req, res) => {
  const { deviceId } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing deviceId' });
  }

  deviceCommands.set(deviceId, {
    type: 'getstatus'
  });

  io.emit('command-sent', { deviceId, type: 'getstatus' });
  res.json({ success: true, message: 'Status request sent' });
});

// Endpoint for ESP32 to check for commands
app.get('/api/device/commands/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const command = deviceCommands.get(deviceId);
  
  if (command) {
    deviceCommands.delete(deviceId);
    res.json(command);
  } else {
    res.json({ type: 'none' });
  }
});

// Data retrieval endpoints for dashboard
app.get('/api/devices', (req, res) => {
  db.all(`SELECT * FROM devices ORDER BY lastSeen DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.get('/api/access-logs', (req, res) => {
  const limit = req.query.limit || 100;
  db.all(
    `SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

app.get('/api/users/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  db.all(
    `SELECT * FROM users WHERE deviceId = ? ORDER BY userId`,
    [deviceId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

app.get('/api/system-logs', (req, res) => {
  const limit = req.query.limit || 50;
  db.all(
    `SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
});
