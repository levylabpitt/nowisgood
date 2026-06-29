/* nowisgood - options page logic. */

const DEFAULTS = {
  providerId: "google",
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  durationOverrideMin: 0,
  calendarIds: ["primary"],
  allDayBusy: false,
  skipDeclined: true,
  markTightAsBad: true,
  preferredEnabled: false,
  preferredStartHour: 9,
  preferredEndHour: 17,
  showPanel: true,
};

const $ = (id) => document.getElementById(id);
let calendars = []; // last-loaded calendar list
let selectedIds = new Set(DEFAULTS.calendarIds);

function load() {
  chrome.storage.sync.get(DEFAULTS, (p) => {
    $("provider").value = p.providerId;
    $("bufBefore").value = p.bufferBeforeMin;
    $("bufAfter").value = p.bufferAfterMin;
    $("durOverride").value = p.durationOverrideMin;
    $("allDayBusy").checked = p.allDayBusy;
    $("skipDeclined").checked = p.skipDeclined;
    $("markTightAsBad").checked = p.markTightAsBad;
    $("preferredEnabled").checked = p.preferredEnabled;
    $("prefStart").value = p.preferredStartHour;
    $("prefEnd").value = p.preferredEndHour;
    $("showPanel").checked = p.showPanel;
    selectedIds = new Set(p.calendarIds || ["primary"]);
    refreshConnection();
  });
}

function collect() {
  // If we have a loaded calendar list, the checkboxes are the source of truth;
  // otherwise keep whatever was previously stored (selectedIds).
  const ids = calendars.length
    ? calendars.filter((c) => document.getElementById("cal_" + c.id)?.checked).map((c) => c.id)
    : [...selectedIds];
  return {
    providerId: $("provider").value,
    bufferBeforeMin: clampInt($("bufBefore").value, 0, 120),
    bufferAfterMin: clampInt($("bufAfter").value, 0, 120),
    durationOverrideMin: clampInt($("durOverride").value, 0, 480),
    calendarIds: ids.length ? ids : ["primary"],
    allDayBusy: $("allDayBusy").checked,
    skipDeclined: $("skipDeclined").checked,
    markTightAsBad: $("markTightAsBad").checked,
    preferredEnabled: $("preferredEnabled").checked,
    preferredStartHour: clampInt($("prefStart").value, 0, 23),
    preferredEndHour: clampInt($("prefEnd").value, 1, 24),
    showPanel: $("showPanel").checked,
  };
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));

function save() {
  chrome.storage.sync.set(collect(), () => {
    $("saved").textContent = "Saved ✓";
    setTimeout(() => ($("saved").textContent = ""), 1800);
  });
}

async function refreshConnection() {
  const el = $("connState");
  el.textContent = "Checking…";
  el.className = "conn";
  const resp = await chrome.runtime.sendMessage({ type: "NIG_LIST_CALENDARS", interactive: false });
  if (resp && resp.ok) {
    el.textContent = "Connected.";
    el.className = "conn ok";
    calendars = resp.calendars;
    renderCalendars();
  } else {
    el.textContent = resp && resp.error
      ? "Not working: " + resp.error
      : "Not connected. Click Connect to authorize Google Calendar.";
    el.className = "conn bad";
  }
}

function renderCalendars() {
  const box = $("calList");
  if (!calendars.length) { box.textContent = "No calendars found."; return; }
  box.classList.remove("muted");
  box.innerHTML = "";
  for (const c of calendars) {
    const id = "cal_" + c.id;
    const row = document.createElement("label");
    const checked = selectedIds.has(c.id) || (selectedIds.has("primary") && c.primary);
    row.innerHTML = `
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
      <span class="swatch" style="background:${c.backgroundColor || "#ccc"}"></span>
      <span>${escapeHtml(c.summary)}${c.primary ? " (primary)" : ""}</span>`;
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* events */
$("connect").onclick = async () => {
  $("connState").textContent = "Opening Google sign-in…";
  const r = await chrome.runtime.sendMessage({ type: "NIG_SIGN_IN" });
  if (!r || !r.ok) {
    $("connState").textContent = "Sign-in failed: " + (r ? r.error : "unknown");
    $("connState").className = "conn bad";
    return;
  }
  refreshConnection();
};
$("disconnect").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "NIG_SIGN_OUT" });
  calendars = [];
  $("calList").textContent = "Connect to load your calendars.";
  $("calList").classList.add("muted");
  refreshConnection();
};
$("reloadCals").onclick = async () => {
  const resp = await chrome.runtime.sendMessage({ type: "NIG_LIST_CALENDARS", interactive: true });
  if (resp && resp.ok) { calendars = resp.calendars; renderCalendars(); refreshConnection(); }
};
$("save").onclick = save;

load();
