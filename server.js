const express = require("express");
const fs = require("fs");
const app = express();

// =================== CONFIG ===================
const PORT = process.env.PORT || 10000; // Render sets a PORT env variable
const STATE_FILE = "state.json";

// =================== LOAD OR INIT STATE ===================
let state = {
  server_message: "Hello ESP",
  led_command: "OFF"
};

if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
  } catch (err) {
    console.log("Failed to load state.json, using default state.");
  }
}

// Helper to save state to file
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// =================== MIDDLEWARE ===================
app.use(express.json());

// =================== ROUTES ===================

// Root page (test in browser)
app.get("/", (req, res) => {
  res.send(`
    <h2>ESP A6 Server</h2>
    <p>LED: ${state.led_command}</p>
    <a href="/esp?led=ON">Turn ON</a><br>
    <a href="/esp?led=OFF">Turn OFF</a>
  `);
});

// ESP endpoint
app.get("/esp", (req, res) => {
  // Check if LED command is provided
  if (req.query.led) {
    const cmd = req.query.led.toUpperCase();
    if (cmd === "ON" || cmd === "OFF") {
      state.led_command = cmd;
      state.server_message = `LED -> ${cmd}`;
      saveState();
      console.log(`LED changed to ${cmd}`);
    }
  }

  // Return JSON to ESP
  res.json(state);
});

// Fallback for undefined routes
app.use((req, res) => {
  res.status(404).send("Route not found");
});

// =================== START SERVER ===================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
