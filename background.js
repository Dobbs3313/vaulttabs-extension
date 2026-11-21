async function captureSession(name, allWindows = true, isAuto = false) {
  const query = allWindows ? {} : { currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  let groupMap = {};
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      groupMap[g.id] = { title: g.title || "", color: g.color || "blue", collapsed: !!g.collapsed };
    }
  } catch { /* tabGroups unavailable */ }

  const cleanTabs = tabs
    .filter(t => t.url && !t.url.startsWith("chrome-extension://"))
    .map(t => ({
      title: t.title || t.url,
      url: t.url,
      pinned: !!t.pinned,
      windowId: t.windowId,
      group: (t.groupId && t.groupId !== -1 && groupMap[t.groupId]) ? groupMap[t.groupId] : null
    }));

  const session = {
    id: `vt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: name || `Session ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    createdAt: Date.now(),
    isAuto,
    tabs: cleanTabs
  };
  return session;
}

async function saveSessionsAtomic(sessions) {
  // Always maintain shadow backup to prevent catastrophic data wipes
  const { vt_sessions = [] } = await chrome.storage.local.get("vt_sessions");
  await chrome.storage.local.set({
    vt_sessions_backup: vt_sessions,
    vt_sessions: sessions
  });
}

async function restoreSession(session, mode = "new-window") {
  if (!session?.tabs?.length) return { ok: false, error: "Session has no tabs." };
  let targetWinId;
  const createdByGroupKey = new Map();

  if (mode === "new-window") {
    const first = session.tabs[0];
    const nw = await chrome.windows.create({ url: first.url });
    targetWinId = nw.id;
    const firstTab = nw.tabs?.[0];
    if (firstTab?.id) {
      if (first.pinned) await chrome.tabs.update(firstTab.id, { pinned: true }).catch(() => {});
      if (first.group) {
        const gk = `${first.group.title}::${first.group.color}`;
        createdByGroupKey.set(gk, { meta: first.group, tabIds: [firstTab.id] });
      }
    }
    for (const t of session.tabs.slice(1)) {
      const created = await chrome.tabs.create({ windowId: targetWinId, url: t.url, pinned: !!t.pinned, active: false });
      if (t.group && created?.id) {
        const gk = `${t.group.title}::${t.group.color}`;
        const bucket = createdByGroupKey.get(gk) || { meta: t.group, tabIds: [] };
        bucket.tabIds.push(created.id);
        createdByGroupKey.set(gk, bucket);
      }
    }
  } else {
    const curWin = await chrome.windows.getCurrent();
    targetWinId = curWin.id;
    // Check existing tabs to avoid URL duplicates on merge
    const existingTabs = await chrome.tabs.query({ windowId: targetWinId });
    const existingUrls = new Set(existingTabs.map(t => t.url));
    for (const t of session.tabs) {
      if (existingUrls.has(t.url)) continue;
      const created = await chrome.tabs.create({ windowId: targetWinId, url: t.url, pinned: !!t.pinned, active: false });
      if (t.group && created?.id) {
        const gk = `${t.group.title}::${t.group.color}`;
        const bucket = createdByGroupKey.get(gk) || { meta: t.group, tabIds: [] };
        bucket.tabIds.push(created.id);
        createdByGroupKey.set(gk, bucket);
      }
    }
  }

  // Deduplicated Chrome Tab Group assignment (matches existing group by title+color!)
  try {
    const existingGroups = await chrome.tabGroups.query({ windowId: targetWinId });
    for (const { meta, tabIds } of createdByGroupKey.values()) {
      if (!tabIds.length) continue;
      const match = existingGroups.find(g => (g.title || "") === (meta.title || "") && g.color === meta.color);
      if (match) {
        await chrome.tabs.group({ groupId: match.id, tabIds });
      } else {
        const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: targetWinId } });
        await chrome.tabGroups.update(gid, { title: meta.title || "", color: meta.color || "blue", collapsed: !!meta.collapsed });
      }
    }
  } catch { /* ignore if tabGroups disabled */ }

  return { ok: true, restored: session.tabs.length };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { vt_config } = await chrome.storage.local.get("vt_config");
  if (!vt_config) await chrome.storage.local.set({ vt_config: { autoBackupMinutes: 0 } });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "vaulttabs-auto") return;
  const { aris_pro_vaulttabs, vt_sessions = [] } = await chrome.storage.local.get(["aris_pro_vaulttabs", "vt_sessions"]);
  if (aris_pro_vaulttabs?.tier !== "pro") return;
  const snap = await captureSession(`Auto Backup ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, true, true);
  if (!snap.tabs.length) return;
  const nonAuto = vt_sessions.filter(s => !s.isAuto);
  const autos = [snap, ...vt_sessions.filter(s => s.isAuto)].slice(0, 12);
  await saveSessionsAtomic([...nonAuto, ...autos].sort((a, b) => b.createdAt - a.createdAt));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "VAULTTABS_CAPTURE") {
    (async () => {
      const { vt_sessions = [], aris_pro_vaulttabs } = await chrome.storage.local.get(["vt_sessions", "aris_pro_vaulttabs"]);
      const isPro = aris_pro_vaulttabs?.tier === "pro";
      if (!isPro && vt_sessions.length >= 10) {
        return sendResponse({ ok: false, needPro: true, error: "Free plan stores up to 10 sessions. Upgrade to VaultTabs Pro for unlimited sessions." });
      }
      const sess = await captureSession(msg.name, msg.allWindows !== false, false);
      await saveSessionsAtomic([sess, ...vt_sessions]);
      sendResponse({ ok: true, session: sess });
    })().catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === "VAULTTABS_RESTORE") {
    restoreSession(msg.session, msg.mode).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === "VAULTTABS_SYNC_ALARM") {
    (async () => {
      await chrome.alarms.clear("vaulttabs-auto");
      const { vt_config, aris_pro_vaulttabs } = await chrome.storage.local.get(["vt_config", "aris_pro_vaulttabs"]);
      if (aris_pro_vaulttabs?.tier === "pro" && vt_config?.autoBackupMinutes > 0) {
        chrome.alarms.create("vaulttabs-auto", { periodInMinutes: Number(vt_config.autoBackupMinutes) });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
