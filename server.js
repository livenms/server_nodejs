const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

// Configuration
const PORT = 3000;
const MQTT_BROKER = 'mqtt://broker.hivemq.com:1883';
const DEVICE_ID = '8C128B2B1838';

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize SQLite Database
const db = new sqlite3.Database('./fingerprint.db', (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('Connected to SQLite database');
    initDatabase();
  }
});

// Create tables
function initDatabase() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT,
    granted INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    message TEXT,
    user_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  console.log('Database tables initialized');
}

// MQTT Client
const mqttClient = mqtt.connect(MQTT_BROKER);
const topicBase = `fingerprint/${DEVICE_ID}`;

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  
  // Subscribe to all device topics
  mqttClient.subscribe(`${topicBase}/#`, (err) => {
    if (!err) {
      console.log(`Subscribed to ${topicBase}/#`);
    }
  });
});

mqttClient.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log('MQTT Message:', topic, data);

    // Broadcast to all connected web clients
    io.emit('mqtt-message', { topic, data });

    // Handle specific topics
    if (topic.endsWith('/access')) {
      handleAccessLog(data);
    } else if (topic.endsWith('/device-event')) {
      handleDeviceEvent(data);
    } else if (topic.endsWith('/status')) {
      handleSystemStatus(data);
    } else if (topic.endsWith('/heartbeat')) {
      io.emit('device-heartbeat', data);
    } else if (topic.endsWith('/enrollment')) {
      io.emit('enrollment-update', data);
    }
  } catch (error) {
    console.error('Error processing MQTT message:', error);
  }
});

// Database Handlers
function handleAccessLog(data) {
  db.run(
    'INSERT INTO access_logs (user_id, user_name, granted) VALUES (?, ?, ?)',
    [data.userId, data.userName, data.granted ? 1 : 0],
    (err) => {
      if (err) console.error('Error saving access log:', err);
      else {
        io.emit('access-log', data);
        getRecentAccessLogs((logs) => {
          io.emit('recent-logs', logs);
        });
      }
    }
  );
}

function handleDeviceEvent(data) {
  db.run(
    'INSERT INTO device_events (action, message, user_id) VALUES (?, ?, ?)',
    [data.action, data.message, data.userId || null],
    (err) => {
      if (err) console.error('Error saving device event:', err);
      else io.emit('device-event', data);
    }
  );
}

function handleSystemStatus(data) {
  if (data.users) {
    // Update users in database
    data.users.forEach(user => {
      db.run(
        'INSERT OR REPLACE INTO users (id, name, phone) VALUES (?, ?, ?)',
        [user.id, user.name, user.phone]
      );
    });
  }
  io.emit('system-status', data);
}

// API Endpoints
app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users ORDER BY id', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.get('/api/access-logs', (req, res) => {
  const limit = req.query.limit || 50;
  db.all(
    'SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows);
      }
    }
  );
});

app.get('/api/device-events', (req, res) => {
  const limit = req.query.limit || 50;
  db.all(
    'SELECT * FROM device_events ORDER BY timestamp DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows);
      }
    }
  );
});

app.post('/api/enroll', (req, res) => {
  const { id, name, phone } = req.body;
  
  if (!id || !name) {
    return res.status(400).json({ error: 'ID and name are required' });
  }

  const command = {
    type: 'enroll',
    id: parseInt(id),
    name: name,
    phone: phone || ''
  };

  mqttClient.publish(`${topicBase}/commands`, JSON.stringify(command));
  res.json({ success: true, message: 'Enrollment command sent' });
});

app.post('/api/delete', (req, res) => {
  const { id } = req.body;
  
  if (!id) {
    return res.status(400).json({ error: 'ID is required' });
  }

  const command = {
    type: 'delete',
    id: parseInt(id)
  };

  mqttClient.publish(`${topicBase}/commands`, JSON.stringify(command));
  
  // Also delete from local database
  db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
    if (err) console.error('Error deleting from database:', err);
  });

  res.json({ success: true, message: 'Delete command sent' });
});

app.post('/api/clear', (req, res) => {
  const command = { type: 'clear' };
  mqttClient.publish(`${topicBase}/commands`, JSON.stringify(command));
  
  // Clear local database
  db.run('DELETE FROM users', [], (err) => {
    if (err) console.error('Error clearing database:', err);
  });

  res.json({ success: true, message: 'Clear all command sent' });
});

app.get('/api/status', (req, res) => {
  const command = { type: 'getstatus' };
  mqttClient.publish(`${topicBase}/commands`, JSON.stringify(command));
  res.json({ success: true, message: 'Status request sent' });
});

// Helper Functions
function getRecentAccessLogs(callback) {
  db.all(
    'SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT 10',
    [],
    (err, rows) => {
      if (!err) callback(rows);
    }
  );
}

// WebSocket Connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send initial data
  db.all('SELECT * FROM users ORDER BY id', [], (err, users) => {
    if (!err) socket.emit('users-list', users);
  });

  getRecentAccessLogs((logs) => {
    socket.emit('recent-logs', logs);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('request-status', () => {
    const command = { type: 'getstatus' };
    mqttClient.publish(`${topicBase}/commands`, JSON.stringify(command));
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`MQTT Device ID: ${DEVICE_ID}`);
});
