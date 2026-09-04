/* nowisgood - popup. Mirrors the in-page panel for people who'd rather drive
   from the toolbar. Talks to the active tab's content script and to the
   background worker for auth status.

   The content script is the authority on whether a page is fillable: we ping
   it and let whichever site adapter loaded there answer, so the popup needs no
   per-site knowledge beyond recognising the hosts we inject on. */

const $ = (id) => document.getElementById(id);

const SUPPORTED = /^https:\/\/(whenisgood\.net|(www\.)?when2meet\.com)\//;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask the content script what it found. Returns null when no content script is
// running on the tab (wrong site, or the page needs a reload after an update).
function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "NIG_PING" }, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp || null);
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
  // A non-interactive calendar probe tells us whether we already have a token.
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
  const onSupportedSite = tab && SUPPORTED.test(tab.url || "");
  const ping = onSupportedSite ? await pingTab(tab.id) : null;
  const hasGrid = !!(ping && ping.hasGrid);

  for (const id of ["fill", "overlay", "clear"]) $(id).disabled = !hasGrid;

  if (!onSupportedSite) {
    $("hint").textContent = "Open a WhenIsGood or when2meet page to fill it.";
  } else if (!ping) {
    $("hint").textContent = "Reload this page, then try again.";
  } else if (!hasGrid) {
    $("hint").textContent =
      ping.site === "when2meet"
        ? "No editable grid yet — sign in to the event with your name first."
        : "No availability grid found on this page.";
  } else {
    $("hint").textContent = "Ready on " + ping.siteName + ".";
  }

  $("fill").onclick = async () => {
    await send(tab.id, "NIG_FILL");
    $("hint").textContent = "Filling… check the page.";
  };
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
