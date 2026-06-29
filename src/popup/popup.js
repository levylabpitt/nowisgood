/* nowisgood - popup. Mirrors the in-page panel for people who'd rather drive
   from the toolbar. Talks to the active tab's content script and to the
   background worker for auth status. */

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function tabHasGrid(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "NIG_PING" }, (resp) => {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(!!(resp && resp.hasGrid));
    });
  });
}

function send(tabId, type) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type }, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

async function refreshConnection() {
  const conn = $("conn");
  // A non-interactive event probe tells us whether we already have a token.
  const resp = await chrome.runtime.sendMessage({
    type: "NIG_LIST_CALENDARS",
    interactive: false,
  });
  if (resp && resp.ok) {
    conn.textContent = "Connected to Google Calendar";
    conn.className = "conn ok";
    $("connect").textContent = "Reconnect";
  } else {
    conn.textContent = "Not connected. Click “Connect Google”.";
    conn.className = "conn bad";
    $("connect").textContent = "Connect Google";
  }
}

async function init() {
  const tab = await activeTab();
  const onWig = tab && /^https:\/\/whenisgood\.net\//.test(tab.url || "");
  const hasGrid = onWig ? await tabHasGrid(tab.id) : false;

  for (const id of ["fill", "overlay", "clear"]) $(id).disabled = !hasGrid;
  if (!onWig) $("hint").textContent = "Open a WhenIsGood respond page to fill it.";
  else if (!hasGrid) $("hint").textContent = "No availability grid found on this page.";

  $("fill").onclick = async () => { await send(tab.id, "NIG_FILL"); $("hint").textContent = "Filling… check the page."; };
  $("overlay").onclick = () => send(tab.id, "NIG_OVERLAY_TOGGLE");
  $("clear").onclick = () => send(tab.id, "NIG_CLEAR");

  $("connect").onclick = async () => {
    $("conn").textContent = "Opening Google sign-in…";
    const r = await chrome.runtime.sendMessage({ type: "NIG_SIGN_IN" });
    if (!r || !r.ok) $("conn").textContent = "Sign-in failed: " + (r ? r.error : "unknown");
    refreshConnection();
  };
  $("options").onclick = () => chrome.runtime.openOptionsPage();

  refreshConnection();
}

init();
