/* Shared helpers for the Broodiinnox portal front-ends. */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body */
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

window.apiGet = (url) => api("GET", url);
window.apiPost = (url, body) => api("POST", url, body);
window.apiPatch = (url, body) => api("PATCH", url, body);
window.apiDelete = (url) => api("DELETE", url);

function ensureToastHost() {
  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    document.body.appendChild(host);
  }
  return host;
}

window.toast = function toast(message, type = "info") {
  const host = ensureToastHost();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.25s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, 3200);
};

window.escapeHtml = function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
};

window.fmtDate = function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

window.fmtMoney = function fmtMoney(amount, currency = "RWF") {
  const n = Number(amount) || 0;
  return `${n.toLocaleString()} ${currency}`;
};

window.subscriptionBadge = function subscriptionBadge(subscription) {
  if (!subscription || subscription.status === "no_payment") {
    return `<span class="badge badge-neutral">No payment yet</span>`;
  }
  if (subscription.status === "overdue") {
    return `<span class="badge badge-danger">Overdue</span>`;
  }
  if (subscription.status === "due_soon") {
    return `<span class="badge badge-warn">Due soon (${subscription.daysLeft}d)</span>`;
  }
  return `<span class="badge badge-ok">Paid</span>`;
};
