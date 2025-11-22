const express = require('express');
const fs = require('fs');
const app = express();

const PORT = process.env.PORT || 80;
const STATE_FILE = 'state.json';

let state = { server_message: "Hello ESP", led_command: "OFF" };

if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
  } catch (e) {
    console.log("Failed to load state");
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// ESP endpoint
app.get('/esp', (req, res) => {
  if (req.query.led) {
    const cmd = req.query.led.toUpperCase();
    if (cmd === "ON" || cmd === "OFF") {
      state.led_command = cmd;
      state.server_message = `LED → ${cmd}`;
      saveState();
    }
  }
  res.json(state);
});

// Simple browser page
app.get('/', (req, res) => {
  res.send(`
    <h2>ESP A6 Server</h2>
    <p>LED: ${state.led_command}</p>
    <a href="/esp?led=ON">Turn ON</a><br>
    <a href="/esp?led=OFF">Turn OFF</a>
  `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
