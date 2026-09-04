/* ==========================================================
   BROODIINNOX FARM USER PORTAL
   ========================================================== */

const PAGE_META = {
  dashboard: { title: "Dashboard", eyebrow: "Live monitoring" },
  account:   { title: "My Account", eyebrow: "Profile & devices" },
};

const DEVICE_STALE_MS = 45000;

let state = {
  me: null,
  devices: [],
  activeDeviceId: null, // devices[].id (record id)
  latestData: {},
  brokerConnected: false,
  deviceOnline: null,
  lastDeviceSeen: 0,
  activeTab: "dashboard",
};

let mqttClient = null;

/* ---------------- BOOTSTRAP ---------------- */
(async function init() {
  try {
    const { user } = await apiGet("/api/session");
    if (!user) { window.location.href = "/login"; return; }
    state.me = user;
    document.getElementById("sbName").textContent = user.name || user.username;
    document.getElementById("sbFarm").textContent = user.farmName || "Farm user";
  } catch (e) {
    window.location.href = "/login";
    return;
  }

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await apiPost("/api/logout");
    window.location.href = "/login";
  });

  document.querySelectorAll(".shell-nav .nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab, btn));
  });

  await loadDevices();
  renderDeviceSwitcher();
  setTab("dashboard");

  setInterval(() => {
    if (state.deviceOnline === true && Date.now() - state.lastDeviceSeen > DEVICE_STALE_MS) {
      state.deviceOnline = false;
      if (state.activeTab === "dashboard") renderDashboard();
    }
  }, 5000);
})();

async function loadDevices() {
  const { devices } = await apiGet("/api/me/devices");
  state.devices = devices;
  if (!state.activeDeviceId && devices.length) {
    state.activeDeviceId = devices[0].id;
  }
}

function activeDevice() {
  return state.devices.find((d) => d.id === state.activeDeviceId) || null;
}

function setTab(tab, btnEl) {
  state.activeTab = tab;
  document.querySelectorAll(".shell-nav .nav-btn").forEach((b) => b.classList.remove("active"));
  const target = btnEl || document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (target) target.classList.add("active");
  const meta = PAGE_META[tab] || PAGE_META.dashboard;
  document.getElementById("pageTitle").textContent = meta.title;
  document.getElementById("pageEyebrow").textContent = meta.eyebrow;
  if (tab === "account") renderAccount();
  else renderDashboard();
}

/* ==========================================================
   DEVICE SWITCHER
   ========================================================== */
function renderDeviceSwitcher() {
  const host = document.getElementById("deviceSwitcherHost");
  if (state.devices.length <= 1) { host.innerHTML = ""; return; }
  host.innerHTML = `
    <select class="device-switcher" id="deviceSwitcher">
      ${state.devices.map((d) => `<option value="${d.id}" ${d.id === state.activeDeviceId ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}
    </select>
  `;
  document.getElementById("deviceSwitcher").addEventListener("change", (e) => {
    switchDevice(e.target.value);
  });
}

function switchDevice(deviceRecordId) {
  state.activeDeviceId = deviceRecordId;
  state.latestData = {};
  state.brokerConnected = false;
  state.deviceOnline = null;
  connectMqttForActiveDevice();
  if (state.activeTab === "dashboard") renderDashboard();
}

/* ==========================================================
   MQTT — one connection at a time, for the selected device
   ========================================================== */
function connectMqttForActiveDevice() {
  if (mqttClient) {
    try { mqttClient.end(true); } catch (e) {}
    mqttClient = null;
  }
  const device = activeDevice();
  if (!device) return;

  const broker = device.mqttBroker || "broker.hivemq.com";
  const prefix = device.topicPrefix || "BROODIINNOX";
  const base = `${prefix}/${device.deviceId}`;

  mqttClient = mqtt.connect(`wss://${broker}:8884/mqtt`, { reconnectPeriod: 3000 });

  mqttClient.on("connect", () => {
    state.brokerConnected = true;
    mqttClient.subscribe(`${base}/data`);
    mqttClient.subscribe(`${base}/status`);
    updateConnectionUI();
  });

  ["reconnect", "close", "offline", "error"].forEach((evt) => {
    mqttClient.on(evt, () => {
      state.brokerConnected = evt === "reconnect" ? false : state.brokerConnected;
      if (evt !== "reconnect") state.brokerConnected = false;
      if (evt === "close" || evt === "offline") state.deviceOnline = null;
      updateConnectionUI();
    });
  });

  mqttClient.on("message", (topic, payload) => {
    const text = payload.toString();
    if (topic === `${base}/status`) {
      try {
        const msg = JSON.parse(text);
        if (msg.status === "offline") { markOffline(); return; }
        if (msg.status === "online") markOnline();
      } catch (e) {
        if (text === "offline") { markOffline(); return; }
        if (text === "online") markOnline();
      }
      return;
    }
    if (topic === `${base}/data`) {
      try {
        state.latestData = JSON.parse(text);
        markOnline();
        if (state.activeTab === "dashboard") renderDashboard();
      } catch (e) {}
    }
  });
}

function markOnline() {
  state.lastDeviceSeen = Date.now();
  if (state.deviceOnline !== true) {
    state.deviceOnline = true;
    updateConnectionUI();
  }
}
function markOffline() {
  state.deviceOnline = false;
  updateConnectionUI();
}

function publish(topic, value) {
  const device = activeDevice();
  if (!device || !mqttClient || !mqttClient.connected) {
    toast("Not connected to the device yet — please wait a moment and try again.", "error");
    return;
  }
  const prefix = device.topicPrefix || "BROODIINNOX";
  mqttClient.publish(`${prefix}/${device.deviceId}/control/${topic}`, String(value));
}

function updateConnectionUI() {
  const brokerDot = document.getElementById("brokerDot");
  const brokerText = document.getElementById("brokerText");
  const deviceDot = document.getElementById("deviceDot");
  const deviceText = document.getElementById("deviceText");
  if (!brokerDot) return;
  brokerDot.className = "status-dot " + (state.brokerConnected ? "online" : "offline");
  brokerText.textContent = state.brokerConnected ? "Broker connected" : "Broker disconnected";
  if (state.deviceOnline === true) {
    deviceDot.className = "status-dot online";
    deviceText.textContent = "Device online";
  } else if (state.deviceOnline === false) {
    deviceDot.className = "status-dot offline";
    deviceText.textContent = "Device offline";
  } else {
    deviceDot.className = "status-dot connecting";
    deviceText.textContent = "Connecting…";
  }
}

/* ==========================================================
   DASHBOARD
   ========================================================== */
function renderDashboard() {
  const el = document.getElementById("content");
  const device = activeDevice();

  if (!device) {
    el.innerHTML = `
      <div class="card no-device-state">
        <div class="empty-icon">&#9737;</div>
        <h3>No device assigned yet</h3>
        <p>Your Afriinnox administrator hasn't linked a Broodiinnox device to your account yet. Please contact them to get started.</p>
      </div>
    `;
    return;
  }

  if (!mqttClient) connectMqttForActiveDevice();

  const d = state.latestData || {};
  const sub = device.subscription;

  el.innerHTML = `
    ${sub.status === "overdue" ? `
      <div class="subscription-banner overdue">
        <span class="icon">&#9888;</span>
        <div><strong>Your subscription is overdue.</strong> Service may be interrupted. Please contact Afriinnox to renew and keep your device running.</div>
      </div>` : ""}
    ${sub.status === "due_soon" ? `
      <div class="subscription-banner due_soon">
        <span class="icon">&#8987;</span>
        <div><strong>Your subscription renews soon</strong> (${sub.daysLeft} day${sub.daysLeft === 1 ? "" : "s"} left). Contact Afriinnox to keep your service uninterrupted.</div>
      </div>` : ""}

    ${d.device_locked ? `
      <div class="locked-notice">
        <span class="icon">&#128274;</span>
        <div><strong>This device is currently locked</strong> and all automatic control is paused. This usually happens when a subscription has lapsed — contact Afriinnox to reactivate it.</div>
      </div>` : ""}

    <div class="connection-strip">
      <div class="conn-item"><span id="brokerDot" class="status-dot"></span><span id="brokerText">Connecting…</span></div>
      <div class="conn-item"><span id="deviceDot" class="status-dot"></span><span id="deviceText">Connecting…</span></div>
      <div class="spacer"></div>
      <div class="conn-item text-muted mono" style="font-size:12px;">${escapeHtml(device.topicPrefix || "BROODIINNOX")}/${escapeHtml(device.deviceId)}</div>
    </div>

    <div class="grid-2">
      <div class="grid-left">
        <div class="card">
          <h3>Temperature</h3>
          ${buildGauge(d)}
        </div>
        <div class="card">
          <h3>Sensor bank</h3>
          ${buildSensorBank(d)}
          <p class="field-hint" style="margin-top:12px;">Tap a sensor to enable or disable it.</p>
        </div>
        <div class="card">
          <h3>Incubation progress</h3>
          ${buildTimeline(d)}
        </div>
      </div>

      <div class="grid-right">
        <div class="card">
          <h3>Heating relay</h3>
          ${buildLampModule(d)}
          <div class="segmented">
            <button onclick="setRelay('AUTO')" class="${!d.manual_control ? "active" : ""}">AUTO</button>
            <button onclick="setRelay('ON')" class="${d.manual_control && d.relay_state ? "active" : ""}">ON</button>
            <button onclick="setRelay('OFF')" class="${d.manual_control && !d.relay_state ? "active" : ""}">OFF</button>
          </div>
          <hr class="divider" />
          <p class="section-title">Animal preset</p>
          <select id="animalPreset" class="preset-select">
            ${["Chicken", "Pig", "Turkey", "Duck"].map(a => `<option value="${a}" ${device.animal === a ? "selected" : ""}>${a}</option>`).join("")}
          </select>
          <button onclick="applyAnimalPreset()" class="btn btn-secondary btn-block">Apply preset</button>
          <hr class="divider" />
          <button onclick="factoryReset()" class="btn btn-outline-danger btn-block">Factory reset…</button>
        </div>

        <div class="card">
          <h3>Setpoints</h3>
          <div class="slider-group">
            <div class="slider-label"><span>Max temperature</span><span class="slider-value" id="maxTVal">${d.max_temp ?? "--"}&deg;C</span></div>
            <input type="range" id="maxTSlider" min="20" max="40" step="0.5" value="${d.max_temp ?? 36}" oninput="document.getElementById('maxTVal').textContent = this.value + '°C'"/>
            <button class="btn btn-secondary btn-sm btn-block" onclick="setMaxTemp()">Apply max temperature</button>
          </div>
          <div class="slider-group">
            <div class="slider-label"><span>Min temperature</span><span class="slider-value" id="minTVal">${d.min_temp ?? "--"}&deg;C</span></div>
            <input type="range" id="minTSlider" min="10" max="38" step="0.5" value="${d.min_temp ?? 32}" oninput="document.getElementById('minTVal').textContent = this.value + '°C'"/>
            <button class="btn btn-secondary btn-sm btn-block" onclick="setMinTemp()">Apply min temperature</button>
          </div>
          <hr class="divider" />
          <div class="detail-row"><span>Signal quality</span><span class="detail-value">${d.signal_quality ?? "--"}</span></div>
          <div class="detail-row"><span>Sensor error</span><span class="detail-value ${d.sensor_error ? "locked" : "unlocked"}">${d.sensor_error ? "YES" : "NO"}</span></div>
          <div class="detail-row"><span>Failsafe mode</span><span class="detail-value ${d.failsafe_mode ? "locked" : "unlocked"}">${d.failsafe_mode ? "ON" : "OFF"}</span></div>
          <div class="detail-row"><span>System mode</span><span class="detail-value">${d.manual_control ? "MANUAL" : "AUTO"}</span></div>
        </div>
      </div>
    </div>

    <details class="raw-data-details">
      <summary>Raw telemetry</summary>
      <pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre>
    </details>
  `;

  updateConnectionUI();
}

function buildGauge(d) {
  const minT = typeof d.min_temp === "number" ? d.min_temp : 30;
  const maxT = typeof d.max_temp === "number" ? d.max_temp : 38;
  const val = typeof d.ave_temp === "number" && d.ave_temp > -900 ? d.ave_temp : null;
  const low = minT - 6, high = maxT + 6;
  const R = 80, ARC_LEN = Math.PI * R;
  let percent = 0;
  if (val !== null) percent = Math.max(0, Math.min(1, (val - low) / (high - low)));
  const dashoffset = ARC_LEN * (1 - percent);

  let s = "ok", caption = "IN RANGE";
  if (d.failsafe_mode || d.sensor_error) { s = "fault"; caption = d.failsafe_mode ? "FAILSAFE ACTIVE" : "SENSOR FAULT"; }
  else if (val === null) { s = "fault"; caption = "NO READING"; }
  else if (val < minT) { s = "cold"; caption = "BELOW SETPOINT"; }
  else if (val > maxT) { s = "hot"; caption = "ABOVE SETPOINT"; }

  return `
    <div class="gauge-wrap">
      <svg class="gauge-svg" viewBox="0 0 200 118">
        <path class="gauge-track" d="M20,100 A80,80 0 0 1 180,100"></path>
        <path class="gauge-arc state-${s}" d="M20,100 A80,80 0 0 1 180,100"
              stroke-dasharray="${ARC_LEN.toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}"></path>
      </svg>
      <div class="gauge-readout">
        <div class="gauge-value">${val !== null ? val.toFixed(1) : "--"}<span class="gauge-unit">&deg;C</span></div>
        <div class="gauge-caption state-${s}">${caption}</div>
      </div>
      <div class="gauge-range"><span>${minT}&deg;C min</span><span>${maxT}&deg;C max</span></div>
    </div>
  `;
}

function buildSensorBank(d) {
  const sensors = [
    { id: "DS1", enabled: !!d.s1_enabled, val: d.sensor1 },
    { id: "DS2", enabled: !!d.s2_enabled, val: d.sensor2 },
    { id: "DS3", enabled: !!d.s3_enabled, val: d.sensor3 },
    { id: "DS4", enabled: !!d.s4_enabled, val: d.sensor4 },
  ];
  return `
    <div class="sensor-bank">
      ${sensors.map((s) => `
        <div class="sensor-cell ${s.enabled ? "active" : ""}" onclick="toggleSensor('${s.id}')" title="Click to toggle ${s.id}">
          <span class="sensor-cell-led"></span>
          <span class="sensor-cell-label">${s.id}</span>
          <span class="sensor-cell-reading">${typeof s.val === "number" ? s.val.toFixed(1) + "°" : (s.enabled ? "ERR" : "OFF")}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function buildLampModule(d) {
  const on = !!d.relay_state;
  return `
    <div class="lamp-module">
      <div class="lamp-icon ${on ? "on" : ""}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 6 9.5 6 14.5C6 18.09 8.69 21 12 21C15.31 21 18 18.09 18 14.5C18 9.5 12 2 12 2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </div>
      <div>
        <div class="lamp-status-text">${on ? "Heat lamp ON" : "Heat lamp OFF"}</div>
        <div class="lamp-status-sub">${d.manual_control ? "Manual override" : "Automatic control"}</div>
      </div>
    </div>
  `;
}

function buildTimeline(d) {
  const day = d.day ?? 0, total = d.total_days ?? 0;
  const percent = total ? Math.round((day / total) * 100) : 0;
  const tickCount = total > 0 ? Math.min(total, 60) : 0;
  let ticks = "";
  for (let i = 1; i <= tickCount; i++) {
    const dayForTick = total > 60 ? Math.round(i * (total / tickCount)) : i;
    let cls = "";
    if (dayForTick < day) cls = "done"; else if (dayForTick === day) cls = "today";
    ticks += `<div class="timeline-tick ${cls}"></div>`;
  }
  return `
    <div class="timeline-header">
      <div class="timeline-day">${day}<span> / ${total || "--"} days</span></div>
      <div class="timeline-percent">${percent}%</div>
    </div>
    <div class="timeline-track">${ticks}</div>
  `;
}

/* ---------------- CONTROLS ---------------- */
window.setRelay = (v) => publish("relay", v);
window.setMaxTemp = () => publish("max_temp", Math.round(Number(document.getElementById("maxTSlider").value)));
window.setMinTemp = () => publish("min_temp", Math.round(Number(document.getElementById("minTSlider").value)));
window.toggleSensor = (id) => {
  const d = state.latestData || {};
  const current = d[`s${id.slice(-1)}_enabled`] ? "ON" : "OFF";
  publish("sensor", `${id}:${current === "ON" ? "OFF" : "ON"}`);
};
window.applyAnimalPreset = () => {
  const preset = document.getElementById("animalPreset")?.value;
  if (!preset) return;
  publish("animal_preset", preset);
  toast(`Applying ${preset} preset…`, "success");
};
window.factoryReset = () => {
  if (confirm("This resets ALL settings on the device to factory Chicken defaults and cannot be undone. Continue?")) {
    publish("factory_reset", "RESET");
    toast("Factory reset command sent.", "success");
  }
};

/* ==========================================================
   ACCOUNT TAB
   ========================================================== */
function renderAccount() {
  const el = document.getElementById("content");
  const u = state.me;
  el.innerHTML = `
    <div class="grid-2">
      <div class="grid-left">
        <div class="card">
          <div class="card-header"><div><h3>Profile</h3><p>Contact Afriinnox to update these details</p></div></div>
          <div class="detail-row"><span>Full name</span><span class="detail-value" style="font-family:var(--font-body);font-weight:600;">${escapeHtml(u.name)}</span></div>
          <div class="detail-row"><span>Username</span><span class="detail-value">${escapeHtml(u.username)}</span></div>
          <div class="detail-row"><span>Farm name</span><span class="detail-value" style="font-family:var(--font-body);">${escapeHtml(u.farmName || "—")}</span></div>
          <div class="detail-row"><span>Phone</span><span class="detail-value" style="font-family:var(--font-body);">${escapeHtml(u.phone || "—")}</span></div>
          <div class="detail-row"><span>Email</span><span class="detail-value" style="font-family:var(--font-body);">${escapeHtml(u.email || "—")}</span></div>
        </div>

        <div class="card">
          <div class="card-header"><div><h3>Security</h3></div></div>
          <button class="btn btn-primary" onclick="openChangePasswordModal()">Change password</button>
        </div>
      </div>

      <div class="grid-right">
        <div class="card">
          <div class="card-header"><div><h3>My devices</h3><p>${state.devices.length} device${state.devices.length === 1 ? "" : "s"}</p></div></div>
          ${state.devices.length ? state.devices.map((d) => `
            <div style="padding:12px 0;border-bottom:1px solid var(--border-soft);">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                <div>
                  <div style="font-weight:700;font-size:13.5px;">${escapeHtml(d.name)}</div>
                  <div class="text-muted mono" style="font-size:11.5px;">${escapeHtml(d.deviceId)}</div>
                </div>
                ${subscriptionBadge(d.subscription)}
              </div>
              <div class="field-hint">${d.subscription.dueDate ? "Subscription valid until " + fmtDate(d.subscription.dueDate) : "No payment on record yet"}</div>
            </div>
          `).join("") : `<p class="text-muted" style="font-size:13px;">No devices assigned yet.</p>`}
        </div>
      </div>
    </div>
  `;
}

function openChangePasswordModal() {
  const host = document.getElementById("modalHost");
  host.innerHTML = `
    <div class="modal">
      <div class="modal-header"><h3>Change my password</h3><button class="modal-close" id="mClose">&times;</button></div>
      <form id="pwForm">
        <div class="modal-body">
          <div class="field"><label for="cp_current">Current password</label><input type="password" id="cp_current" required /></div>
          <div class="field"><label for="cp_new">New password</label><input type="password" id="cp_new" placeholder="min. 6 characters" required /></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="mCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Update password</button>
        </div>
      </form>
    </div>
  `;
  host.classList.remove("hidden");
  const close = () => host.classList.add("hidden");
  document.getElementById("mClose").onclick = close;
  document.getElementById("mCancel").onclick = close;
  host.onclick = (e) => { if (e.target === host) close(); };
  document.getElementById("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await apiPost("/api/me/password", {
        currentPassword: document.getElementById("cp_current").value,
        newPassword: document.getElementById("cp_new").value,
      });
      toast("Password updated.", "success");
      close();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
window.openChangePasswordModal = openChangePasswordModal;
