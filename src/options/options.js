/* nowisgood - options page logic. Shared by every site adapter; a few settings
   only bite on one of them and say so in the page copy. */

const DEFAULTS = {
  providerId: "google",
  mode: "calendar",
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  durationOverrideMin: 0,
  calendarIds: ["primary"],
  useAllCalendars: false,
  allDayBusy: false,
  allDayOwnedOnly: true,
  skipDeclined: true,
  markTightAsBad: true,
  windowEnabled: false,
  windowDays: [1, 2, 3, 4, 5],
  windowStartHour: 9,
  windowEndHour: 18,
  preferredEnabled: false,
  preferredStartHour: 9,
  preferredEndHour: 17,
  overwrite: true,
  showPanel: true,
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const $ = (id) => document.getElementById(id);
let calendars = []; // last-loaded calendar list
let selectedIds = new Set(DEFAULTS.calendarIds);

function buildDays(selected) {
  const wrap = $("windowDays");
  wrap.innerHTML = "";
  DAY_NAMES.forEach((name, i) => {
    const label = document.createElement("label");
    label.className = "day";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "dayCb";
    cb.value = String(i);
    cb.checked = selected.includes(i);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + name));
    wrap.appendChild(label);
  });
}

function readDays() {
  return [...document.querySelectorAll(".dayCb")]
    .filter((c) => c.checked)
    .map((c) => parseInt(c.value, 10));
}

// Calendar-only sections are pointless in manual mode, so fold them away.
function reflectMode() {
  const cal = $("mode").value === "calendar";
  for (const id of ["calSection", "calListSection", "bufferSection", "busySection", "preferredSection"]) {
    $(id).style.display = cal ? "" : "none";
  }
  $("modeHint").textContent = cal
    ? "Reads your calendar and marks every free slot (inside the hours below) as available."
    : "Marks the whole window below as available and never touches your calendar — no sign-in needed.";
}

function reflectCalendarScope() {
  const all = $("useAllCalendars").checked;
  $("calList").style.opacity = all ? "0.45" : "";
  $("calList").style.pointerEvents = all ? "none" : "";
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (p) => {
    $("provider").value = p.providerId;
    $("mode").value = p.mode;
    $("bufBefore").value = p.bufferBeforeMin;
    $("bufAfter").value = p.bufferAfterMin;
    $("durOverride").value = p.durationOverrideMin;
    $("useAllCalendars").checked = p.useAllCalendars;
    $("allDayBusy").checked = p.allDayBusy;
    $("allDayOwnedOnly").checked = p.allDayOwnedOnly;
    $("skipDeclined").checked = p.skipDeclined;
    $("markTightAsBad").checked = p.markTightAsBad;
    $("windowEnabled").checked = p.windowEnabled;
    $("winStart").value = p.windowStartHour;
    $("winEnd").value = p.windowEndHour;
    $("preferredEnabled").checked = p.preferredEnabled;
    $("prefStart").value = p.preferredStartHour;
    $("prefEnd").value = p.preferredEndHour;
    $("overwrite").checked = p.overwrite;
    $("showPanel").checked = p.showPanel;
    buildDays(p.windowDays || DEFAULTS.windowDays);
    selectedIds = new Set(p.calendarIds || ["primary"]);
    reflectMode();
    reflectCalendarScope();
    refreshConnection();
  });
}

function collect() {
  // If we have a loaded calendar list, the checkboxes are the source of truth;
  // otherwise keep whatever was previously stored (selectedIds).
  const ids = calendars.length
    ? calendars.filter((c) => document.getElementById("cal_" + c.id)?.checked).map((c) => c.id)
    : [...selectedIds];
  const days = readDays();
  return {
    providerId: $("provider").value,
    mode: $("mode").value === "manual" ? "manual" : "calendar",
    bufferBeforeMin: clampInt($("bufBefore").value, 0, 120),
    bufferAfterMin: clampInt($("bufAfter").value, 0, 120),
    durationOverrideMin: clampInt($("durOverride").value, 0, 480),
    calendarIds: ids.length ? ids : ["primary"],
    useAllCalendars: $("useAllCalendars").checked,
    allDayBusy: $("allDayBusy").checked,
    allDayOwnedOnly: $("allDayOwnedOnly").checked,
    skipDeclined: $("skipDeclined").checked,
    markTightAsBad: $("markTightAsBad").checked,
    windowEnabled: $("windowEnabled").checked,
    // An empty day list would silently block every slot, so fall back to all days.
    windowDays: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    windowStartHour: clampInt($("winStart").value, 0, 23),
    windowEndHour: clampInt($("winEnd").value, 1, 24),
    preferredEnabled: $("preferredEnabled").checked,
    preferredStartHour: clampInt($("prefStart").value, 0, 23),
    preferredEndHour: clampInt($("prefEnd").value, 1, 24),
    overwrite: $("overwrite").checked,
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
      : "Not connected. Click Connect to authorize your calendar.";
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
    // Read-only calendars can't contribute all-day busy time under the owned-only
    // guard, so flag them rather than leaving the user guessing.
    const readOnly = c.accessRole && c.accessRole !== "owner" && c.accessRole !== "writer";
    row.innerHTML = `
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
      <span class="swatch" style="background:${c.backgroundColor || "#ccc"}"></span>
      <span>${escapeHtml(c.summary)}${c.primary ? " (primary)" : ""}${readOnly ? ' <small class="muted">read-only</small>' : ""}</span>`;
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* events */
$("mode").onchange = reflectMode;
$("useAllCalendars").onchange = reflectCalendarScope;

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
