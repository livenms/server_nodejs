const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
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

// MQTT Configuration - Same as ESP32
const MQTT_BROKER = 'mqtt://broker.hivemq.com:1883';
const MQTT_TOPIC_BASE = 'fingerprint/#';

// Connect to MQTT
const mqttClient = mqtt.connect(MQTT_BROKER);

// Store connected devices and data
const connectedDevices = new Map();

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  mqttClient.subscribe(MQTT_TOPIC_BASE, (err) => {
    if (!err) {
      console.log('✅ Subscribed to MQTT topics:', MQTT_TOPIC_BASE);
    } else {
      console.error('❌ Subscription error:', err);
    }
  });
});

mqttClient.on('message', (topic, message) => {
  try {
    const messageString = message.toString();
    const topicParts = topic.split('/');
    const deviceId = topicParts[1];
    const messageType = topicParts[2];
    
    console.log(`📨 MQTT [${deviceId}/${messageType}]: ${messageString.substring(0, 100)}`);
    
    let data;
    
    try {
      data = JSON.parse(messageString);
    } catch (jsonError) {
      data = {
        type: 'message',
        text: messageString,
        deviceId: deviceId,
        timestamp: new Date().toISOString()
      };
    }

    // Update device last seen
    connectedDevices.set(deviceId, {
      ...connectedDevices.get(deviceId),
      lastSeen: new Date(),
      status: 'online',
      ip: data.ip || connectedDevices.get(deviceId)?.ip,
      rssi: data.rssi || connectedDevices.get(deviceId)?.rssi
    });

    // FIXED: Proper message routing with better data handling
    if (data.type === 'heartbeat' || messageType === 'heartbeat') {
      io.emit('heartbeat', { ...data, deviceId, timestamp: new Date() });
    }
    else if (data.type === 'status' || messageType === 'status') {
      io.emit('status', { ...data, deviceId });
      if (data.users) {
        updateUsers(deviceId, data.users);
      }
    }
    else if (data.type === 'access' || messageType === 'access') {
      // FIX: Ensure proper data structure for access logs
      const accessData = {
        deviceId,
        userId: data.userId || data.id || 0,
        userName: data.userName || data.name || 'Unknown',
        cardId: data.cardId || '',
        granted: data.granted || false,
        timestamp: new Date()
      };
      
      io.emit('access', accessData);
      saveAccessLog(deviceId, accessData);
    }
    else if (data.type === 'enrollment' || messageType === 'enrollment') {
      io.emit('enrollment', { ...data, deviceId, timestamp: new Date() });
      saveSystemLog(deviceId, 'enrollment', data.status || data.text);
    }
    else if (data.type === 'device-event' || messageType === 'device-event') {
      io.emit('device-event', { ...data, deviceId, timestamp: new Date() });
      saveSystemLog(deviceId, 'system', data.action || data.message || data.text);
    }
    else {
      io.emit('message', { ...data, deviceId, timestamp: new Date(), topic });
    }
    
  } catch (error) {
    console.error('❌ Error processing MQTT message:', error);
    console.error('Message content:', message.toString());
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database(':memory:');

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
    cardId TEXT,
    granted BOOLEAN,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    userId INTEGER,
    userName TEXT,
    userPhone TEXT,
    cardId TEXT,
    enrolledAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    type TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

function updateUsers(deviceId, users) {
  db.run('DELETE FROM users WHERE deviceId = ?', [deviceId], (err) => {
    if (err) console.error('Error clearing users:', err);
    
    if (users && Array.isArray(users)) {
      users.forEach(user => {
        // FIX: Handle different user object structures
        const userData = {
          id: user.id || user.userId,
          name: user.name || user.userName || 'Unknown',
          phone: user.phone || user.userPhone || '',
          cardId: user.cardId || user.cardID || ''
        };
        
        db.run(
          `INSERT INTO users (deviceId, userId, userName, userPhone, cardId) VALUES (?, ?, ?, ?, ?)`,
          [deviceId, userData.id, userData.name, userData.phone, userData.cardId]
        );
      });
    }
  });
}

function saveAccessLog(deviceId, data) {
  if (data.userName !== undefined && data.userId !== undefined && data.granted !== undefined) {
    db.run(
      `INSERT INTO access_logs (deviceId, userName, userId, cardId, granted) VALUES (?, ?, ?, ?, ?)`,
      [deviceId, data.userName, data.userId, data.cardId || '', data.granted]
    );
  }
}

function saveSystemLog(deviceId, type, message) {
  if (message) {
    db.run(
      `INSERT INTO system_logs (deviceId, type, message) VALUES (?, ?, ?)`,
      [deviceId, type, message]
    );
  }
}

// Command endpoints - Send commands via MQTT
app.post('/api/command/enroll', (req, res) => {
  const { deviceId, id, cardId, name, phone } = req.body;
  
  if (!deviceId || !id || !name || !cardId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const command = {
    type: 'enroll',
    id: parseInt(id),
    cardId: cardId,
    name: name,
    phone: phone || ''
  };

  const topic = `fingerprint/${deviceId}/commands`;
  mqttClient.publish(topic, JSON.stringify(command));

  console.log(`📤 Sent enroll command to ${deviceId}:`, command);
  io.emit('command-sent', { deviceId, type: 'enroll', id, name, cardId });
  
  res.json({ 
    success: true, 
    message: 'Enrollment command sent via MQTT',
    command: command
  });
});

app.post('/api/command/delete', (req, res) => {
  const { deviceId, id } = req.body;
  
  if (!deviceId || !id) {
    return res.status(400).json({ error: 'Missing deviceId or id' });
  }

  const command = {
    type: 'delete',
    id: parseInt(id)
  };

  const topic = `fingerprint/${deviceId}/commands`;
  mqttClient.publish(topic, JSON.stringify(command));

  console.log(`📤 Sent delete command to ${deviceId}:`, command);
  io.emit('command-sent', { deviceId, type: 'delete', id });
  
  res.json({ 
    success: true, 
    message: 'Delete command sent via MQTT',
    command: command
  });
});

app.post('/api/command/clear', (req, res) => {
  const { deviceId } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing deviceId' });
  }

  const command = {
    type: 'clear'
  };

  const topic = `fingerprint/${deviceId}/commands`;
  mqttClient.publish(topic, JSON.stringify(command));

  console.log(`📤 Sent clear command to ${deviceId}`);
  io.emit('command-sent', { deviceId, type: 'clear' });
  
  res.json({ 
    success: true, 
    message: 'Clear all command sent via MQTT',
    command: command
  });
});

app.post('/api/command/getstatus', (req, res) => {
  const { deviceId } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing deviceId' });
  }

  const command = {
    type: 'getstatus'
  };

  const topic = `fingerprint/${deviceId}/commands`;
  mqttClient.publish(topic, JSON.stringify(command));

  console.log(`📤 Sent status request to ${deviceId}`);
  io.emit('command-sent', { deviceId, type: 'getstatus' });
  
  res.json({ 
    success: true, 
    message: 'Status request sent via MQTT',
    command: command
  });
});

// Data retrieval endpoints
app.get('/api/devices', (req, res) => {
  const onlineDevices = Array.from(connectedDevices.entries()).map(([deviceId, data]) => ({
    deviceId,
    ip: data.ip || 'Unknown',
    lastSeen: data.lastSeen,
    status: 'online',
    rssi: data.rssi
  }));

  res.json(onlineDevices);
});

app.get('/api/access-logs', (req, res) => {
  const limit = req.query.limit || 50;
  db.all(
    `SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/users/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  db.all(
    `SELECT userId, userName, userPhone, cardId FROM users WHERE deviceId = ? ORDER BY userId`,
    [deviceId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
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
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mqtt: mqttClient.connected,
    connectedDevices: connectedDevices.size,
    timestamp: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Fingerprint Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 MQTT Broker: ${MQTT_BROKER}`);
});
