// lib/websocket.js
import { WebSocketServer } from "ws";
import * as db from "./db.js";

let wss = null;
const clients = new Map(); // deviceId -> Set of WebSocket connections
const deviceSessions = new Map(); // deviceId -> latest data

export function initWebSocketServer(server) {
  wss = new WebSocketServer({ server });
  
  wss.on("connection", (ws, req) => {
    // Parse device ID from URL query param
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get("deviceId");
    const role = url.searchParams.get("role") || "user";
    
    if (!deviceId) {
      ws.close(1008, "Device ID required");
      return;
    }
    
    // Verify device exists
    const device = db.findDeviceByExternalId(deviceId);
    if (!device) {
      ws.close(1008, "Device not found");
      return;
    }
    
    // Store client connection
    if (!clients.has(deviceId)) {
      clients.set(deviceId, new Set());
    }
    clients.get(deviceId).add(ws);
    
    // Send latest known data if available
    if (deviceSessions.has(deviceId)) {
      ws.send(JSON.stringify({
        type: "data",
        payload: deviceSessions.get(deviceId)
      }));
    }
    
    // Send initial status
    ws.send(JSON.stringify({
      type: "status",
      payload: { status: "connected", timestamp: Date.now() }
    }));
    
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleDeviceMessage(deviceId, data, ws);
      } catch (e) {
        // Ignore invalid messages
      }
    });
    
    ws.on("close", () => {
      const set = clients.get(deviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          clients.delete(deviceId);
        }
      }
    });
  });
  
  return wss;
}

function handleDeviceMessage(deviceId, data, ws) {
  // Device -> Server: telemetry data
  if (data.type === "telemetry") {
    deviceSessions.set(deviceId, {
      ...data.payload,
      _timestamp: Date.now(),
      _deviceId: deviceId
    });
    
    // Broadcast to all clients listening to this device
    broadcastToDevice(deviceId, {
      type: "data",
      payload: deviceSessions.get(deviceId)
    });
  }
  
  // Device -> Server: status updates
  if (data.type === "status") {
    broadcastToDevice(deviceId, {
      type: "status",
      payload: { 
        status: data.payload.status || "online",
        timestamp: Date.now()
      }
    });
  }
}

function broadcastToDevice(deviceId, message) {
  const set = clients.get(deviceId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const client of set) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Admin can send commands to a device
export function sendCommand(deviceId, command, value) {
  const set = clients.get(deviceId);
  if (!set || set.size === 0) {
    throw new Error("Device not connected");
  }
  
  const payload = JSON.stringify({
    type: "command",
    command: command,
    value: value
  });
  
  let sent = false;
  for (const client of set) {
    if (client.readyState === 1) {
      client.send(payload);
      sent = true;
    }
  }
  
  if (!sent) {
    throw new Error("Device not reachable");
  }
}

// Simulate a device (for testing without real hardware)
export function simulateDevice(deviceId, interval = 5000) {
  let running = true;
  
  const generateData = () => {
    if (!running) return;
    
    const now = Date.now();
    const data = {
      deviceId: deviceId,
      timestamp: now,
      ave_temp: 32 + Math.random() * 4,
      sensor1: 31 + Math.random() * 5,
      sensor2: 32 + Math.random() * 4,
      sensor3: 33 + Math.random() * 3,
      sensor4: 30 + Math.random() * 5,
      s1_enabled: true,
      s2_enabled: true,
      s3_enabled: true,
      s4_enabled: true,
      relay_state: Math.random() > 0.5,
      manual_control: false,
      device_locked: false,
      max_temp: 37,
      min_temp: 30,
      day: Math.floor(Math.random() * 21),
      total_days: 21,
      signal_quality: "Good",
      sensor_error: false,
      failsafe_mode: false
    };
    
    deviceSessions.set(deviceId, data);
    broadcastToDevice(deviceId, {
      type: "data",
      payload: data
    });
    
    setTimeout(generateData, interval);
  };
  
  generateData();
  
  return () => {
    running = false;
  };
}

export function getDeviceSessions() {
  return deviceSessions;
}

export function isDeviceConnected(deviceId) {
  const set = clients.get(deviceId);
  return set && set.size > 0;
}
