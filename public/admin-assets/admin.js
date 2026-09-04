/* ==========================================================
   BROODIINNOX ADMIN CONSOLE
   ========================================================== */

const PAGE_META = {
  overview: { title: "Overview", eyebrow: "Fleet overview" },
  devices:  { title: "Devices",  eyebrow: "Device fleet management" },
  users:    { title: "Farm Users", eyebrow: "Accounts & access" },
  payments: { title: "Payments", eyebrow: "Subscriptions & billing" },
};

let state = {
  me: null,
  devices: [],
  users: [],
  payments: [],
  stats: {},
  liveStatus: {}, // deviceRecordId -> { online: bool, lastTemp, lastSeen }
  activeTab: "overview",
};

const mqttClients = {}; // broker -> mqtt.js client, shared across devices on same broker

/* ---------------- BOOTSTRAP ---------------- */
(async function init() {
  try {
    const { user } = await apiGet("/api/session");
    if (!user || user.role !== "admin") {
      window.location.href = "/login";
      return;
    }
    state.me = user;
    document.getElementById("sbName").textContent = user.name || user.username;
  } catch (e) {
    window.location.href = "/login";
    return;
  }

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await apiPost("/api/logout");
    window.location.href = "/login";
  });
  document.getElementById("changePwBtn").addEventListener("click", openChangePasswordModal);

  document.querySelectorAll(".shell-nav .nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab, btn));
  });

  await refreshAll();
  connectLiveStatusForDevices();
  setTab("overview");
})();

async function refreshAll() {
  const [stats, devicesRes, usersRes, paymentsRes] = await Promise.all([
    apiGet("/api/admin/stats"),
    apiGet("/api/admin/devices"),
    apiGet("/api/admin/users"),
    apiGet("/api/admin/payments"),
  ]);
  state.stats = stats;
  state.devices = devicesRes.devices;
  state.users = usersRes.users;
  state.payments = paymentsRes.payments;
}

function setTab(tab, btnEl) {
  state.activeTab = tab;
  document.querySelectorAll(".shell-nav .nav-btn").forEach((b) => b.classList.remove("active"));
  const target = btnEl || document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (target) target.classList.add("active");

  const meta = PAGE_META[tab] || PAGE_META.overview;
  document.getElementById("pageTitle").textContent = meta.title;
  document.getElementById("pageEyebrow").textContent = meta.eyebrow;

  const renderers = {
    overview: renderOverview,
    devices: renderDevices,
    users: renderUsers,
    payments: renderPayments,
  };
  (renderers[tab] || renderOverview)();
}

/* ==========================================================
   LIVE MQTT STATUS (browser-side, public broker)
   ========================================================== */
function connectLiveStatusForDevices() {
  const byBroker = {};
  state.devices.forEach((d) => {
    const broker = d.mqttBroker || "broker.hivemq.com";
    (byBroker[broker] = byBroker[broker] || []).push(d);
  });

  Object.entries(byBroker).forEach(([broker, devices]) => {
    if (mqttClients[broker]) return; // already connected
    let client;
    try {
      client = mqtt.connect(`wss://${broker}:8884/mqtt`, { reconnectPeriod: 4000 });
    } catch (e) {
      return;
    }
    mqttClients[broker] = client;

    client.on("connect", () => {
      devices.forEach((d) => {
        const prefix = d.topicPrefix || "BROODIINNOX";
        client.subscribe(`${prefix}/${d.deviceId}/status`);
        client.subscribe(`${prefix}/${d.deviceId}/data`);
      });
    });

    client.on("message", (topic, payload) => {
      // Topic prefix varies per firmware build (e.g. "BROODIINNOX" vs
      // "broodinnox"), so match on the device ID segment rather than a
      // fixed prefix: "<anything>/<deviceId>/(status|data)".
      const match = topic.match(/^[^/]+\/([^/]+)\/(status|data)$/);
      if (!match) return;
      const externalId = match[1];
      const device = state.devices.find((d) => d.deviceId === externalId);
      if (!device) return;

      let msg;
      try {
        msg = JSON.parse(payload.toString());
      } catch (e) {
        return;
      }

      const online = msg.status ? msg.status !== "offline" : true;
      state.liveStatus[device.id] = {
        online,
        lastSeen: Date.now(),
        aveTemp: typeof msg.ave_temp === "number" && msg.ave_temp > -900 ? msg.ave_temp : null,
        deviceLocked: !!msg.device_locked,
      };

      if (state.activeTab === "devices") renderDevices();
      if (state.activeTab === "overview") renderOverview();
    });
  });
}

function publishDeviceCommand(device, topic, value) {
  const broker = device.mqttBroker || "broker.hivemq.com";
  const client = mqttClients[broker];
  if (!client || !client.connected) {
    toast("Not connected to the MQTT broker yet — try again in a moment.", "error");
    return;
  }
  const prefix = device.topicPrefix || "BROODIINNOX";
  client.publish(`${prefix}/${device.deviceId}/control/${topic}`, String(value));
  toast(`Command sent to ${device.name}.`, "success");
}

function toggleDeviceLock(deviceRecordId) {
  const device = state.devices.find((d) => d.id === deviceRecordId);
  if (!device) return;
  const live = state.liveStatus[device.id];
  const currentlyLocked = live ? !!live.deviceLocked : false;
  const nextAction = currentlyLocked ? "ACTIVE" : "LOCKED";

  openModal({
    title: currentlyLocked ? `Unlock "${device.name}"?` : `Lock "${device.name}"?`,
    bodyHtml: currentlyLocked
      ? `<p>This reactivates the device — the relay, alarm and controls resume normal operation immediately.</p>`
      : `<p>This immediately disables the relay, alarm and all controls on the device (used when a subscription lapses). The farm user will see a "locked" notice on their dashboard.</p>`,
    submitLabel: currentlyLocked ? "Unlock device" : "Lock device",
    danger: !currentlyLocked,
    onSubmit: async () => {
      publishDeviceCommand(device, "device_active", nextAction);
    },
  });
}
window.toggleDeviceLock = toggleDeviceLock;

/* ==========================================================
   OVERVIEW TAB
   ========================================================== */
function renderOverview() {
  const s = state.stats;
  const overdueDevices = state.devices.filter(
    (d) => d.subscription.status === "overdue"
  );
  const unassigned = state.devices.filter((d) => !d.ownerId);

  document.getElementById("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon">&#9737;</div>
        <div class="stat-label">Total devices</div>
        <div class="stat-value">${s.totalDevices ?? 0}</div>
        <div class="stat-sub">${s.unassignedDevices ?? 0} unassigned</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">&#9782;</div>
        <div class="stat-label">Farm users</div>
        <div class="stat-value">${s.totalUsers ?? 0}</div>
        <div class="stat-sub">Active accounts</div>
      </div>
      <div class="stat-card accent-danger">
        <div class="stat-icon">&#9888;</div>
        <div class="stat-label">Overdue subscriptions</div>
        <div class="stat-value">${s.overdue ?? 0}</div>
        <div class="stat-sub">Needs attention</div>
      </div>
      <div class="stat-card accent-warn">
        <div class="stat-icon">&#8987;</div>
        <div class="stat-label">Due within 7 days</div>
        <div class="stat-value">${s.dueSoon ?? 0}</div>
        <div class="stat-sub">Upcoming renewals</div>
      </div>
      <div class="stat-card accent-ok">
        <div class="stat-icon">&#8383;</div>
        <div class="stat-label">Revenue this month</div>
        <div class="stat-value" style="font-size:20px;">${fmtMoney(s.revenueThisMonth || 0)}</div>
        <div class="stat-sub">Recorded payments</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div>
            <h3>Subscriptions needing attention</h3>
            <p>Overdue or due within 7 days</p>
          </div>
        </div>
        ${renderAttentionList([...overdueDevices, ...state.devices.filter(d => d.subscription.status === "due_soon")])}
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h3>Unassigned devices</h3>
            <p>Not yet linked to a farm user</p>
          </div>
        </div>
        ${renderUnassignedList(unassigned)}
      </div>
    </div>
  `;
}

function renderAttentionList(devices) {
  if (!devices.length) {
    return `<div class="empty-state"><div class="empty-icon">&#10003;</div><h4>All caught up</h4><p>No overdue or soon-to-expire subscriptions.</p></div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Device</th><th>Owner</th><th>Status</th><th>Due</th></tr></thead>
        <tbody>
          ${devices.map((d) => `
            <tr>
              <td><div class="device-row-name">${escapeHtml(d.name)}</div><div class="device-row-id">${escapeHtml(d.deviceId)}</div></td>
              <td>${d.ownerName ? escapeHtml(d.ownerName) : `<span class="unassigned-tag">Unassigned</span>`}</td>
              <td>${subscriptionBadge(d.subscription)}</td>
              <td class="muted">${fmtDate(d.subscription.dueDate)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderUnassignedList(devices) {
  if (!devices.length) {
    return `<div class="empty-state"><div class="empty-icon">&#9737;</div><h4>Nothing unassigned</h4><p>Every device has an owner.</p></div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Device</th><th>Broker</th><th></th></tr></thead>
        <tbody>
          ${devices.map((d) => `
            <tr>
              <td><div class="device-row-name">${escapeHtml(d.name)}</div><div class="device-row-id">${escapeHtml(d.deviceId)}</div></td>
              <td class="muted mono">${escapeHtml(d.mqttBroker)}</td>
              <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="openAssignModal('${d.id}')">Assign</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

/* ==========================================================
   DEVICES TAB
   ========================================================== */
function renderDevices() {
  const rows = state.devices.map((d) => {
    const live = state.liveStatus[d.id];
    const dotClass = live ? (live.online ? "online" : "offline") : "";
    const liveLabel = live ? (live.online ? "Online" : "Offline") : "Connecting…";
    const tempLabel = live && live.aveTemp !== null ? `${live.aveTemp.toFixed(1)}&deg;C` : "—";
    const locked = live ? live.deviceLocked : null;
    const lockBadge =
      locked === null
        ? `<span class="badge badge-neutral">Unknown</span>`
        : locked
        ? `<span class="badge badge-danger">Locked</span>`
        : `<span class="badge badge-ok">Active</span>`;
    const lockBtnLabel = locked ? "Unlock" : "Lock";
    const lockBtnClass = locked ? "btn-secondary" : "btn-outline-danger";

    return `
      <tr>
        <td>
          <div class="device-row-name">${escapeHtml(d.name)}</div>
          <div class="device-row-id">${escapeHtml(d.topicPrefix || "BROODIINNOX")}/${escapeHtml(d.deviceId)}</div>
        </td>
        <td>${d.ownerId ? ownerPill(d) : `<span class="unassigned-tag">Unassigned</span>`}</td>
        <td><span class="badge badge-neutral">${escapeHtml(d.animal)}</span></td>
        <td><span class="live-dot ${dotClass}"></span>${liveLabel}</td>
        <td class="mono">${tempLabel}</td>
        <td>${subscriptionBadge(d.subscription)}<span class="subscription-cell"><span class="sub-date">${d.subscription.dueDate ? "Due " + fmtDate(d.subscription.dueDate) : ""}</span></span></td>
        <td>${lockBadge}</td>
        <td>
          <div class="row-actions">
            <button class="btn ${lockBtnClass} btn-sm" onclick="toggleDeviceLock('${d.id}')" ${live ? "" : "disabled title=\"Waiting for live connection…\""}>${lockBtnLabel}</button>
            <button class="btn btn-secondary btn-sm" onclick="openAssignModal('${d.id}')">Assign</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal('${d.id}')">Edit</button>
            <button class="btn btn-outline-danger btn-sm" onclick="confirmDeleteDevice('${d.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.getElementById("content").innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h3>Device fleet</h3>
          <p>${state.devices.length} device${state.devices.length === 1 ? "" : "s"} registered</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddDeviceModal()">+ Add device</button>
      </div>
      ${state.devices.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>Device</th><th>Owner</th><th>Animal</th><th>Live status</th><th>Avg temp</th><th>Subscription</th><th>Security</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : `<div class="empty-state"><div class="empty-icon">&#9737;</div><h4>No devices yet</h4><p>Add your first Broodiinnox device to get started.</p></div>`}
    </div>
  `;
}

function ownerPill(d) {
  const initials = (d.ownerName || d.ownerUsername || "?").slice(0, 2).toUpperCase();
  return `<span class="owner-pill"><span class="avatar">${initials}</span> ${escapeHtml(d.ownerName || d.ownerUsername)}</span>`;
}

function openAddDeviceModal() {
  openModal({
    title: "Add device",
    bodyHtml: deviceFormHtml(),
    submitLabel: "Add device",
    onSubmit: async (fd) => {
      await apiPost("/api/admin/devices", fd);
      toast("Device added.", "success");
      await refreshAll();
      connectLiveStatusForDevices();
      renderDevices();
    },
  });
}

function openEditDeviceModal(deviceRecordId) {
  const d = state.devices.find((x) => x.id === deviceRecordId);
  if (!d) return;
  openModal({
    title: "Edit device",
    bodyHtml: deviceFormHtml(d),
    submitLabel: "Save changes",
    onSubmit: async (fd) => {
      delete fd.deviceId; // device ID is immutable after creation
      await apiPatch(`/api/admin/devices/${deviceRecordId}`, fd);
      toast("Device updated.", "success");
      await refreshAll();
      renderDevices();
    },
  });
  if (d) document.getElementById("f_deviceId").disabled = true;
}

function deviceFormHtml(d) {
  d = d || {};
  return `
    <div class="field">
      <label for="f_deviceId">Device ID <span class="text-muted">(matches firmware DEVICE_ID)</span></label>
      <input type="text" id="f_deviceId" name="deviceId" placeholder="BROODIINNOX-002" value="${escapeHtml(d.deviceId || "")}" required />
    </div>
    <div class="field">
      <label for="f_name">Friendly name</label>
      <input type="text" id="f_name" name="name" placeholder="e.g. Nyagatare Farm - Coop 1" value="${escapeHtml(d.name || "")}" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f_animal">Animal preset</label>
        <select id="f_animal" name="animal">
          ${["Chicken", "Pig", "Turkey", "Duck"].map(a => `<option ${d.animal === a ? "selected" : ""}>${a}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="f_broker">MQTT broker</label>
        <input type="text" id="f_broker" name="mqttBroker" placeholder="broker.hivemq.com" value="${escapeHtml(d.mqttBroker || "broker.hivemq.com")}" />
      </div>
    </div>
    <div class="field">
      <label for="f_prefix">MQTT topic prefix</label>
      <input type="text" id="f_prefix" name="topicPrefix" placeholder="BROODIINNOX" value="${escapeHtml(d.topicPrefix || "BROODIINNOX")}" required />
      <p class="field-hint">Must exactly match the prefix your firmware publishes with — check the <code>topic_data</code> line in the .ino file (e.g. <code>BROODIINNOX</code> or <code>broodinnox</code>). Case-sensitive.</p>
    </div>
    <div class="field">
      <label for="f_location">Location <span class="text-muted">(optional)</span></label>
      <input type="text" id="f_location" name="location" placeholder="e.g. Nyagatare, Rwanda" value="${escapeHtml(d.location || "")}" />
    </div>
  `;
}

function openAssignModal(deviceRecordId) {
  const d = state.devices.find((x) => x.id === deviceRecordId);
  if (!d) return;
  const options = [`<option value="">— Unassigned —</option>`]
    .concat(state.users.map((u) => `<option value="${u.id}" ${u.id === d.ownerId ? "selected" : ""}>${escapeHtml(u.name)} (${escapeHtml(u.username)})</option>`));

  openModal({
    title: `Assign "${d.name}"`,
    bodyHtml: `
      <div class="field">
        <label for="f_owner">Farm user</label>
        <select id="f_owner" name="ownerId">${options.join("")}</select>
        <p class="field-hint">Assigning a device grants that farm user live monitoring &amp; control access in their portal.</p>
      </div>
    `,
    submitLabel: "Save assignment",
    onSubmit: async (fd) => {
      await apiPatch(`/api/admin/devices/${deviceRecordId}`, { ownerId: fd.ownerId || null });
      toast("Device assignment updated.", "success");
      await refreshAll();
      renderDevices();
    },
  });
}

function confirmDeleteDevice(deviceRecordId) {
  const d = state.devices.find((x) => x.id === deviceRecordId);
  if (!d) return;
  openModal({
    title: "Delete device?",
    bodyHtml: `<p>This will permanently remove <strong>${escapeHtml(d.name)}</strong> (${escapeHtml(d.deviceId)}) and its payment history. This can't be undone.</p>`,
    submitLabel: "Delete device",
    danger: true,
    onSubmit: async () => {
      await apiDelete(`/api/admin/devices/${deviceRecordId}`);
      toast("Device deleted.", "success");
      await refreshAll();
      renderDevices();
    },
  });
}

window.openAssignModal = openAssignModal;
window.openAddDeviceModal = openAddDeviceModal;
window.openEditDeviceModal = openEditDeviceModal;
window.confirmDeleteDevice = confirmDeleteDevice;

/* ==========================================================
   USERS TAB
   ========================================================== */
function renderUsers() {
  const rows = state.users.map((u) => {
    const deviceCount = state.devices.filter((d) => d.ownerId === u.id).length;
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="avatar">${escapeHtml((u.name || u.username).slice(0, 2).toUpperCase())}</span>
            <div>
              <div class="device-row-name">${escapeHtml(u.name)}</div>
              <div class="device-row-id">@${escapeHtml(u.username)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(u.farmName || "—")}</td>
        <td class="muted">${escapeHtml(u.phone || "—")}</td>
        <td>${deviceCount} device${deviceCount === 1 ? "" : "s"}</td>
        <td>${u.active ? `<span class="badge badge-ok">Active</span>` : `<span class="badge badge-neutral">Disabled</span>`}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm" onclick="openEditUserModal('${u.id}')">Edit</button>
            <button class="btn btn-secondary btn-sm" onclick="openResetPasswordModal('${u.id}')">Reset password</button>
            <button class="btn btn-outline-danger btn-sm" onclick="confirmDeleteUser('${u.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.getElementById("content").innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h3>Farm user accounts</h3>
          <p>${state.users.length} account${state.users.length === 1 ? "" : "s"}</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddUserModal()">+ New farm user</button>
      </div>
      ${state.users.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>User</th><th>Farm</th><th>Phone</th><th>Devices</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : `<div class="empty-state"><div class="empty-icon">&#9782;</div><h4>No farm users yet</h4><p>Create an account so a farmer can log in and monitor their device.</p></div>`}
    </div>
  `;
}

function userFormHtml(u) {
  u = u || {};
  return `
    <div class="field-row">
      <div class="field">
        <label for="f_uname">Username</label>
        <input type="text" id="f_uname" name="username" value="${escapeHtml(u.username || "")}" ${u.id ? "disabled" : "required"} placeholder="e.g. jmugisha" />
      </div>
      ${u.id ? "" : `
      <div class="field">
        <label for="f_pw">Temporary password</label>
        <input type="text" id="f_pw" name="password" placeholder="min. 6 characters" required />
      </div>`}
    </div>
    <div class="field">
      <label for="f_name2">Full name</label>
      <input type="text" id="f_name2" name="name" value="${escapeHtml(u.name || "")}" placeholder="e.g. Jean Mugisha" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f_farm">Farm name</label>
        <input type="text" id="f_farm" name="farmName" value="${escapeHtml(u.farmName || "")}" placeholder="e.g. Mugisha Poultry Farm" />
      </div>
      <div class="field">
        <label for="f_phone">Phone</label>
        <input type="tel" id="f_phone" name="phone" value="${escapeHtml(u.phone || "")}" placeholder="+250 7xx xxx xxx" />
      </div>
    </div>
    <div class="field">
      <label for="f_email">Email <span class="text-muted">(optional)</span></label>
      <input type="email" id="f_email" name="email" value="${escapeHtml(u.email || "")}" placeholder="name@example.com" />
    </div>
    ${u.id ? `
    <div class="field checkbox-row">
      <input type="checkbox" id="f_active" name="active" ${u.active ? "checked" : ""} />
      <label for="f_active" style="margin:0;">Account active (unchecked = login disabled)</label>
    </div>` : ""}
  `;
}

function openAddUserModal() {
  openModal({
    title: "New farm user",
    bodyHtml: userFormHtml(),
    submitLabel: "Create account",
    onSubmit: async (fd) => {
      await apiPost("/api/admin/users", fd);
      toast("Farm user created.", "success");
      await refreshAll();
      renderUsers();
    },
  });
}

function openEditUserModal(userId) {
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  openModal({
    title: "Edit farm user",
    bodyHtml: userFormHtml(u),
    submitLabel: "Save changes",
    onSubmit: async (fd) => {
      fd.active = fd.active === "on" || fd.active === true;
      delete fd.username;
      await apiPatch(`/api/admin/users/${userId}`, fd);
      toast("Account updated.", "success");
      await refreshAll();
      renderUsers();
    },
  });
}

function openResetPasswordModal(userId) {
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  openModal({
    title: `Reset password for ${u.name}`,
    bodyHtml: `
      <div class="field">
        <label for="f_newpw">New temporary password</label>
        <input type="text" id="f_newpw" name="newPassword" placeholder="min. 6 characters" required />
      </div>
      <p class="field-hint">Share this with the farm user through a secure channel. They'll be asked to keep it safe.</p>
    `,
    submitLabel: "Reset password",
    onSubmit: async (fd) => {
      await apiPost(`/api/admin/users/${userId}/reset-password`, fd);
      toast("Password reset.", "success");
    },
  });
}

function confirmDeleteUser(userId) {
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  openModal({
    title: "Delete account?",
    bodyHtml: `<p>This removes <strong>${escapeHtml(u.name)}</strong>'s login. Any devices assigned to them will become unassigned.</p>`,
    submitLabel: "Delete account",
    danger: true,
    onSubmit: async () => {
      await apiDelete(`/api/admin/users/${userId}`);
      toast("Account deleted.", "success");
      await refreshAll();
      renderUsers();
    },
  });
}

window.openAddUserModal = openAddUserModal;
window.openEditUserModal = openEditUserModal;
window.openResetPasswordModal = openResetPasswordModal;
window.confirmDeleteUser = confirmDeleteUser;

/* ==========================================================
   PAYMENTS TAB
   ========================================================== */
function renderPayments() {
  const rows = state.payments.map((p) => `
    <tr>
      <td><div class="device-row-name">${escapeHtml(p.deviceName)}</div><div class="device-row-id">${escapeHtml(p.deviceExternalId)}</div></td>
      <td class="mono">${fmtMoney(p.amount, p.currency)}</td>
      <td>${fmtDate(p.paidOn)}</td>
      <td>${fmtDate(p.dueDate)}</td>
      <td class="muted">${p.periodDays} days</td>
      <td class="muted">${escapeHtml(p.note || "—")}</td>
      <td><button class="btn btn-outline-danger btn-sm" onclick="confirmDeletePayment('${p.id}')">Delete</button></td>
    </tr>
  `).join("");

  document.getElementById("content").innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h3>Payment history</h3>
          <p>${state.payments.length} recorded payment${state.payments.length === 1 ? "" : "s"}</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAddPaymentModal()">+ Record payment</button>
      </div>
      ${state.payments.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Device</th><th>Amount</th><th>Paid on</th><th>Valid until</th><th>Period</th><th>Note</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : `<div class="empty-state"><div class="empty-icon">&#8383;</div><h4>No payments recorded</h4><p>Record a payment to activate a device's subscription period.</p></div>`}
    </div>
  `;
}

function openAddPaymentModal() {
  if (!state.devices.length) {
    toast("Add a device first before recording a payment.", "error");
    return;
  }
  const options = state.devices.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} — ${escapeHtml(d.deviceId)}</option>`).join("");
  const todayIso = new Date().toISOString().slice(0, 10);

  openModal({
    title: "Record payment",
    bodyHtml: `
      <div class="field">
        <label for="p_device">Device</label>
        <select id="p_device" name="deviceId">${options}</select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="p_amount">Amount</label>
          <input type="number" id="p_amount" name="amount" min="0" step="1" placeholder="15000" required />
        </div>
        <div class="field">
          <label for="p_currency">Currency</label>
          <select id="p_currency" name="currency">
            <option value="RWF" selected>RWF</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="p_paidOn">Paid on</label>
          <input type="date" id="p_paidOn" name="paidOn" value="${todayIso}" />
        </div>
        <div class="field">
          <label for="p_period">Subscription period (days)</label>
          <input type="number" id="p_period" name="periodDays" min="1" value="30" />
        </div>
      </div>
      <div class="field">
        <label for="p_note">Note <span class="text-muted">(optional)</span></label>
        <input type="text" id="p_note" name="note" placeholder="e.g. Mobile money ref #12345" />
      </div>
    `,
    submitLabel: "Save payment",
    onSubmit: async (fd) => {
      await apiPost("/api/admin/payments", fd);
      toast("Payment recorded.", "success");
      await refreshAll();
      renderPayments();
    },
  });
}

function confirmDeletePayment(paymentId) {
  openModal({
    title: "Delete payment record?",
    bodyHtml: `<p>This will remove the record and may change the device's live subscription status.</p>`,
    submitLabel: "Delete record",
    danger: true,
    onSubmit: async () => {
      await apiDelete(`/api/admin/payments/${paymentId}`);
      toast("Payment record deleted.", "success");
      await refreshAll();
      renderPayments();
    },
  });
}

window.openAddPaymentModal = openAddPaymentModal;
window.confirmDeletePayment = confirmDeletePayment;

/* ==========================================================
   GENERIC MODAL
   ========================================================== */
function openModal({ title, bodyHtml, submitLabel, onSubmit, danger }) {
  const host = document.getElementById("modalHost");
  host.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="modal-close" id="modalCloseBtn">&times;</button>
      </div>
      <form id="modalForm">
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modalCancelBtn">Cancel</button>
          <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}" id="modalSubmitBtn">${escapeHtml(submitLabel)}</button>
        </div>
      </form>
    </div>
  `;
  host.classList.remove("hidden");

  const close = () => host.classList.add("hidden");
  document.getElementById("modalCloseBtn").onclick = close;
  document.getElementById("modalCancelBtn").onclick = close;
  host.onclick = (e) => { if (e.target === host) close(); };

  document.getElementById("modalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById("modalSubmitBtn");
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = "Please wait…";
    try {
      const fd = Object.fromEntries(new FormData(e.target).entries());
      await onSubmit(fd);
      close();
    } catch (err) {
      toast(err.message || "Something went wrong.", "error");
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}

function openChangePasswordModal() {
  openModal({
    title: "Change my password",
    bodyHtml: `
      <div class="field">
        <label for="cp_current">Current password</label>
        <input type="password" id="cp_current" name="currentPassword" required />
      </div>
      <div class="field">
        <label for="cp_new">New password</label>
        <input type="password" id="cp_new" name="newPassword" placeholder="min. 6 characters" required />
      </div>
    `,
    submitLabel: "Update password",
    onSubmit: async (fd) => {
      await apiPost("/api/me/password", fd);
      toast("Password updated.", "success");
    },
  });
}
