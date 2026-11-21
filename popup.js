import { BillingManager } from "./lib/billing.js";
import { BILLING_CONFIG } from "./lib/billing-config.js";

const billing = new BillingManager(BILLING_CONFIG);
let sessions = [];
let toastTimer = null;

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `panel-${name}`));
}

async function loadSessions() {
  const data = await chrome.storage.local.get(["vt_sessions", "vt_config"]);
  sessions = data.vt_sessions || [];
  document.getElementById("autoBackupSelect").value = String(data.vt_config?.autoBackupMinutes || 0);
  render();
}

function render() {
  const pill = document.getElementById("tierPill");
  pill.textContent = billing.isPro() ? "PRO" : "FREE";
  pill.classList.toggle("pro", billing.isPro());

  const q = document.getElementById("filterInput").value.trim().toLowerCase();
  const list = document.getElementById("sessionsList");
  const visible = sessions.filter(s => !q || s.name.toLowerCase().includes(q) || s.tabs.some(t => (t.title + t.url).toLowerCase().includes(q)));

  if (!visible.length) {
    list.innerHTML = `<div class="card muted" style="text-align:center;">No saved sessions yet. Click "Save All Windows" to create a crash-proof snapshot.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const s of visible) {
    const groupsCount = new Set(s.tabs.filter(t => t.group).map(t => `${t.group.title}::${t.group.color}`)).size;
    const div = document.createElement("div");
    div.className = "list-item";
    div.style.flexDirection = "column";
    div.style.alignItems = "stretch";
    const dt = new Date(s.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    div.innerHTML = `
      <div class="row">
        <div class="list-item-main">
          <div class="truncate" style="font-weight:700;">${s.isAuto ? "⏱ " : "🔐 "}${s.name}</div>
          <div class="muted">${s.tabs.length} tabs${groupsCount ? ` · ${groupsCount} groups` : ""} · ${dt}</div>
        </div>
      </div>
      <div class="row" style="margin-top:6px;">
        <button class="btn btn-primary btn-sm" data-act="new-window" style="flex:1;">Open Window</button>
        <button class="btn btn-sm" data-act="merge" style="flex:1;">Merge Here</button>
        <button class="btn btn-danger btn-sm" data-act="delete">✕</button>
      </div>
    `;

    div.querySelector("[data-act='new-window']").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "VAULTTABS_RESTORE", session: s, mode: "new-window" });
      showToast(res?.ok ? `Restored ${res.restored} tabs!` : (res?.error || "Restore failed."));
    });
    div.querySelector("[data-act='merge']").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "VAULTTABS_RESTORE", session: s, mode: "merge" });
      showToast(res?.ok ? "Merged into current window (deduplicated groups)!" : (res?.error || "Merge failed."));
    });
    div.querySelector("[data-act='delete']").addEventListener("click", async () => {
      const next = sessions.filter(x => x.id !== s.id);
      await chrome.storage.local.set({ vt_sessions_backup: sessions, vt_sessions: next });
      sessions = next;
      render();
      showToast("Session deleted (shadow backup kept).");
    });

    list.appendChild(div);
  }
}

async function init() {
  await billing.init();
  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  document.getElementById("tierPill").addEventListener("click", () => switchTab("pro"));
  billing.mountProPanel(document.getElementById("panel-pro"), { onToast: showToast, onTierChange: render });

  async function saveSnapshot(allWindows) {
    const inp = document.getElementById("sessionNameInput");
    const res = await chrome.runtime.sendMessage({ type: "VAULTTABS_CAPTURE", name: inp.value.trim(), allWindows });
    if (res?.ok) {
      inp.value = "";
      showToast(`Saved "${res.session.name}" (${res.session.tabs.length} tabs).`);
      await loadSessions();
    } else {
      showToast(res?.error || "Save failed.");
      if (res?.needPro) switchTab("pro");
    }
  }

  document.getElementById("saveAllBtn").addEventListener("click", () => saveSnapshot(true));
  document.getElementById("saveWinBtn").addEventListener("click", () => saveSnapshot(false));
  document.getElementById("filterInput").addEventListener("input", render);

  document.getElementById("autoBackupSelect").addEventListener("change", async (e) => {
    const mins = Number(e.target.value);
    if (mins > 0 && !billing.isPro()) {
      e.target.value = "0";
      showToast("Rolling automatic snapshots require VaultTabs Pro.");
      return switchTab("pro");
    }
    await chrome.storage.local.set({ vt_config: { autoBackupMinutes: mins } });
    await chrome.runtime.sendMessage({ type: "VAULTTABS_SYNC_ALARM" });
    showToast(mins > 0 ? `Auto-backup every ${mins} min.` : "Auto-backup disabled.");
  });

  document.getElementById("exportJsonBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sessions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vaulttabs-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${sessions.length} sessions.`);
  });

  document.getElementById("importJsonBtn").addEventListener("click", () => document.getElementById("importFileInput").click());
  document.getElementById("importFileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
      if (!Array.isArray(incoming) || !incoming.length) throw new Error("No sessions found in JSON.");
      const merged = [...incoming, ...sessions];
      await chrome.storage.local.set({ vt_sessions_backup: sessions, vt_sessions: merged });
      showToast(`Imported ${incoming.length} sessions!`);
      await loadSessions();
    } catch (err) {
      showToast(`Import error: ${err.message}`);
    }
  });

  document.getElementById("recoverBackupBtn").addEventListener("click", async () => {
    const { vt_sessions_backup = [] } = await chrome.storage.local.get("vt_sessions_backup");
    if (!vt_sessions_backup.length) return showToast("No shadow backup available yet.");
    await chrome.storage.local.set({ vt_sessions: vt_sessions_backup });
    showToast(`Recovered ${vt_sessions_backup.length} sessions from shadow backup!`);
    await loadSessions();
  });

  await loadSessions();
}

init();
