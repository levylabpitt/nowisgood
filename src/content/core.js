/*  nowisgood - shared content-script core
 *
 *  Site-agnostic half of the extension: preferences, calendar busy-detection,
 *  slot classification, the floating panel, the click-through overlay, and the
 *  popup message handlers.
 *
 *  Everything that knows about a *particular* scheduling site lives in a site
 *  adapter (src/content/sites/*.js), which registers itself on
 *  window.__NIG_ADAPTERS before this file runs. The manifest injects exactly
 *  one adapter per site, so the first adapter whose detect() finds a grid wins.
 *
 *  Adapter contract (see sites/whenisgood.js for the reference implementation):
 *
 *    id            string, e.g. "whenisgood"
 *    siteName      human label for the UI, e.g. "WhenIsGood"
 *    rawUnitMs     multiplier turning the site's raw slot key into ms
 *                  (1 for epoch-millis ids, 1000 for epoch-seconds ids)
 *    caps          { states, autosaves, needsSignIn, canClear, overlay }
 *                    states 4 -> free/tight/preferred are distinct marks
 *                    states 2 -> binary available/not (tight collapses to not)
 *    detect()      -> bool, is this page a fillable grid right now?
 *    slots()       -> [{ cell, raw, startMs }]  raw is the site's own uniform
 *                    slot key, used for slot-length inference; startMs is the
 *                    real instant the slot begins.
 *    ensureReady() -> Promise<{ ok, message }>  pre-flight (e.g. sign-in check)
 *    paint(classified, opts) -> { marked, cleared }
 *    clear()       -> { cleared }
 *    verify(slots) -> { ok, note }  site-specific sanity check after a fill
 *    supportNote() -> HTML string shown at the bottom of the panel
 */
(() => {
  "use strict";

  const adapter = (window.__NIG_ADAPTERS || []).find((a) => {
    try { return a.detect(); } catch (_) { return false; }
  }) || (window.__NIG_ADAPTERS || [])[0];
  if (!adapter) return;

  const MIN = 60000;

  const DEFAULTS = {
    providerId: "google",
    mode: "calendar",            // "calendar" | "manual"
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    durationOverrideMin: 0,      // 0 = infer slot length from the grid
    calendarIds: ["primary"],
    useAllCalendars: false,      // ignore calendarIds, use every calendar
    allDayBusy: false,           // treat all-day events as busy?
    allDayOwnedOnly: true,       // ...but only on calendars you own or can edit
    skipDeclined: true,
    markTightAsBad: true,        // free-but-buffer-violated -> its own state
    windowEnabled: false,        // hard day/hour filter (slots outside are never marked)
    windowDays: [1, 2, 3, 4, 5], // 0=Sun .. 6=Sat
    windowStartHour: 9,
    windowEndHour: 18,
    preferredEnabled: false,     // soft highlight for fully-free slots in a window
    preferredStartHour: 9,
    preferredEndHour: 17,
    overwrite: true,             // on autosaving sites, also clear slots you're busy for
    showPanel: true,
  };

  let prefs = { ...DEFAULTS };
  let lastClassified = null; // cached classification for the overlay
  let overlayOn = false;

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));

  function localTzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; }
    catch (_) { return "local time"; }
  }

  /* ------------------------------------------------------ slot geometry -- */

  // Smallest positive gap between distinct raw slot keys == the grid increment.
  // Uses the site's own raw keys (uniform) rather than DST-adjusted instants.
  function inferSlotLengthMs(slots) {
    const keys = [...new Set(slots.map((s) => s.raw))].sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < keys.length; i++) {
      const d = keys[i] - keys[i - 1];
      if (d > 0 && d < gap) gap = d;
    }
    return isFinite(gap) ? gap * adapter.rawUnitMs : 30 * MIN;
  }

  function slotLengthMs(slots) {
    return prefs.durationOverrideMin > 0
      ? prefs.durationOverrideMin * MIN
      : inferSlotLengthMs(slots);
  }

  /* ----------------------------------------------------- busy detection -- */

  // Collapse the worker's events into busy intervals, applying the user's
  // policy. `roles` maps calendarId -> accessRole so all-day events on
  // subscribed calendars (Holidays, Birthdays) don't blank out whole days.
  function busyIntervals(events, roles) {
    // An empty map means the worker couldn't read the calendar list at all, so
    // we can't judge ownership -- fall back to permissive rather than silently
    // dropping every all-day event.
    const rolesKnown = roles && Object.keys(roles).length > 0;
    return events
      .filter((e) => {
        if (e.status === "cancelled") return false;
        if (e.transparency === "transparent") return false; // shown as Free
        if (prefs.skipDeclined && e.responseStatus === "declined") return false;
        if (e.allDay) {
          if (!prefs.allDayBusy) return false;
          if (prefs.allDayOwnedOnly && rolesKnown) {
            const role = roles[e.calendarId] || "reader";
            if (role !== "owner" && role !== "writer") return false;
          }
        }
        return true;
      })
      .map((e) => ({ start: e.startMs, end: e.endMs, summary: e.summary }));
  }

  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

  // A slot is "outside" when the hard day/hour window excludes it. The window
  // is evaluated in the viewer's local time, on the slot's own start.
  function outsideWindow(startMs) {
    if (!prefs.windowEnabled) return false;
    const d = new Date(startMs);
    if (!prefs.windowDays.includes(d.getDay())) return true;
    const hr = d.getHours() + d.getMinutes() / 60;
    return hr < prefs.windowStartHour || hr >= prefs.windowEndHour;
  }

  function isPreferred(startMs) {
    if (!prefs.preferredEnabled) return false;
    const h = new Date(startMs).getHours();
    return h >= prefs.preferredStartHour && h < prefs.preferredEndHour;
  }

  // Classify every slot -> { cell, startMs, endMs, state, preferred, conflict }
  // state in: "free" | "tight" | "busy" | "outside"
  function classify(slots, busy) {
    const slotLen = slotLengthMs(slots);
    const before = prefs.bufferBeforeMin * MIN;
    const after = prefs.bufferAfterMin * MIN;

    return slots.map(({ cell, startMs }) => {
      const endMs = startMs + slotLen;
      if (outsideWindow(startMs)) {
        return { cell, startMs, endMs, state: "outside", preferred: false, conflict: null };
      }
      // Manual mode ignores the calendar entirely: the window IS the answer.
      if (prefs.mode === "manual") {
        return { cell, startMs, endMs, state: "free", preferred: isPreferred(startMs), conflict: null };
      }
      let coreHit = null;
      let bufferHit = false;
      for (const b of busy) {
        if (overlaps(startMs, endMs, b.start, b.end)) { coreHit = b; break; }
        if (overlaps(startMs - before, endMs + after, b.start, b.end)) bufferHit = true;
      }
      let state = "free";
      let conflict = null;
      if (coreHit) { state = "busy"; conflict = coreHit; }
      else if (bufferHit && prefs.markTightAsBad) state = "tight";
      return { cell, startMs, endMs, state, preferred: state === "free" && isPreferred(startMs), conflict };
    });
  }

  /* ------------------------------------------------------- the overlay -- */
  // A click-through layer: one translucent badge per slot cell, tinted by
  // free/busy, busy cells labelled with the conflicting event. pointer-events
  // is none on the whole layer so the grid underneath stays fully usable.

  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.className = "nig-overlay";
    document.body.appendChild(overlayEl);
    window.addEventListener("scroll", positionOverlay, { passive: true });
    window.addEventListener("resize", positionOverlay, { passive: true });
    return overlayEl;
  }

  function buildOverlay(classified) {
    const layer = ensureOverlay();
    layer.innerHTML = "";
    for (const c of classified) {
      const m = document.createElement("div");
      m.className = "nig-cell nig-" + c.state;
      m.dataset.startMs = String(c.startMs);
      if (c.state === "busy" && c.conflict) {
        const label = document.createElement("span");
        label.className = "nig-label";
        label.textContent = c.conflict.summary;
        m.appendChild(label);
      }
      layer.appendChild(m);
    }
    positionOverlay();
  }

  function positionOverlay() {
    if (!overlayEl || !overlayOn) return;
    const markers = overlayEl.children;
    const classified = lastClassified || [];
    for (let i = 0; i < markers.length && i < classified.length; i++) {
      const r = classified[i].cell.getBoundingClientRect();
      const m = markers[i];
      m.style.left = r.left + window.scrollX + "px";
      m.style.top = r.top + window.scrollY + "px";
      m.style.width = r.width + "px";
      m.style.height = r.height + "px";
    }
  }

  function setOverlay(on) {
    if (!adapter.caps.overlay) return false;
    overlayOn = on;
    if (on) {
      if (!lastClassified) return false; // nothing to show until a fill runs
      buildOverlay(lastClassified);
      ensureOverlay().style.display = "block";
      positionOverlay();
    } else if (overlayEl) {
      overlayEl.style.display = "none";
    }
    if (panel) panel.querySelector(".nig-btn-overlay")?.classList.toggle("nig-active", on);
    return true;
  }

  /* ------------------------------------------------------------- fill -- */

  async function fetchEvents(slots, slotLen) {
    const starts = slots.map((s) => s.startMs);
    const timeMin = new Date(Math.min(...starts) - prefs.bufferBeforeMin * MIN - MIN).toISOString();
    const timeMax = new Date(Math.max(...starts) + slotLen + prefs.bufferAfterMin * MIN + MIN).toISOString();
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "NIG_LIST_EVENTS",
        timeMin,
        timeMax,
        calendarIds: prefs.calendarIds,
        allCalendars: !!prefs.useAllCalendars,
        interactive: true,
      });
    } catch (e) {
      throw new Error("Messaging error: " + e.message);
    }
    if (!resp || !resp.ok) {
      const msg = resp ? resp.error : "no response";
      if (/no token|OAuth2 not granted|not signed/i.test(msg)) {
        throw new Error("Not connected. Open Settings to connect your calendar, or switch to Manual mode.");
      }
      throw new Error("Calendar error: " + msg);
    }
    return resp;
  }

  async function runFill() {
    const ready = await adapter.ensureReady();
    if (!ready.ok) return setStatus(ready.message, "error");

    const slots = adapter.slots();
    if (!slots.length) return setStatus("No availability grid found on this page.", "error");
    const slotLen = slotLengthMs(slots);

    let busy = [];
    if (prefs.mode === "calendar") {
      setStatus("Reading your calendar...", "busy");
      let resp;
      try {
        resp = await fetchEvents(slots, slotLen);
      } catch (e) {
        return setStatus(e.message, "error");
      }
      busy = busyIntervals(resp.events, resp.roles);
    } else {
      setStatus("Filling your manual window...", "busy");
    }

    const classified = classify(slots, busy);
    lastClassified = classified;

    let result;
    try {
      result = adapter.paint(classified, { overwrite: prefs.overwrite });
    } catch (e) {
      return setStatus("Couldn't paint the grid: " + (e.message || e), "error");
    }
    if (overlayOn) buildOverlay(classified);

    const counts = classified.reduce((a, c) => ((a[c.state] = (a[c.state] || 0) + 1), a), {});
    const tz = localTzName();
    const check = adapter.verify(slots);
    const parts = [
      (counts.free || 0) + " free",
      adapter.caps.states === 4 ? (counts.tight || 0) + " tight" : null,
      (counts.busy || 0) + " busy",
      prefs.windowEnabled ? (counts.outside || 0) + " outside hours" : null,
    ].filter(Boolean);

    if (!check.ok) {
      setStatus(check.note + " Double-check before " + (adapter.caps.autosaves ? "leaving." : "sending."), "error");
      return;
    }
    setStatus(
      "Filled in " + tz + ": " + parts.join(", ") + ". " +
      "Marked " + result.marked + (result.cleared ? ", cleared " + result.cleared : "") + ". " +
      (adapter.caps.autosaves ? adapter.siteName + " saves automatically." : "Review and tweak, then SEND."),
      "ok"
    );
  }

  function runClear() {
    const result = adapter.clear();
    setOverlay(false);
    lastClassified = null;
    setStatus("Cleared " + result.cleared + " slot(s).", "ok");
  }

  /* ----------------------------------------------------- control panel -- */

  let panel = null;

  function setStatus(text, kind) {
    if (!panel) return;
    const s = panel.querySelector(".nig-status");
    s.textContent = text;
    s.className = "nig-status nig-status-" + (kind || "");
  }

  function buildPanel() {
    if (panel || !prefs.showPanel) return;
    panel = document.createElement("div");
    panel.className = "nig-panel";
    panel.innerHTML = `
      <div class="nig-head">
        <span class="nig-logo">nowisgood</span>
        <span class="nig-site"></span>
        <button class="nig-x" title="Hide panel">&times;</button>
      </div>
      <div class="nig-body">
        <div class="nig-row nig-buttons">
          <button class="nig-btn nig-btn-fill">Fill my availability</button>
          <button class="nig-btn nig-btn-clear" title="Reset all slots">Clear</button>
        </div>
        <div class="nig-row">
          <label class="nig-mode">Source
            <select class="nig-mode-sel">
              <option value="calendar">Calendar</option>
              <option value="manual">Manual window</option>
            </select>
          </label>
        </div>
        <div class="nig-row nig-bufrow">
          <label class="nig-buf">Buffer before
            <input type="number" min="0" max="120" step="5" class="nig-before"> min</label>
          <label class="nig-buf">after
            <input type="number" min="0" max="120" step="5" class="nig-after"> min</label>
        </div>
        <div class="nig-row nig-buttons">
          <button class="nig-btn nig-btn-overlay" title="Translucent calendar overlay (click-through)">Overlay</button>
          <button class="nig-btn nig-btn-gear" title="Settings">&#9881; Settings</button>
        </div>
        <div class="nig-status"></div>
        <div class="nig-support"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector(".nig-site").textContent = adapter.siteName;
    panel.querySelector(".nig-support").innerHTML = adapter.supportNote();
    if (!adapter.caps.overlay) panel.querySelector(".nig-btn-overlay").style.display = "none";
    if (!adapter.caps.canClear) panel.querySelector(".nig-btn-clear").style.display = "none";

    // x dismisses the panel entirely. Bring it back via the toolbar popup
    // ("Fill current page"), a page reload, or turn it off for good in Settings.
    panel.querySelector(".nig-x").addEventListener("click", () => {
      panel.style.display = "none";
      setOverlay(false);
    });
    panel.querySelector(".nig-btn-fill").addEventListener("click", runFill);
    panel.querySelector(".nig-btn-clear").addEventListener("click", runClear);
    panel.querySelector(".nig-btn-overlay").addEventListener("click", () => {
      const ok = setOverlay(!overlayOn);
      if (!ok) setStatus("Run a fill first, then toggle the overlay.", "");
    });
    panel.querySelector(".nig-btn-gear").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "NIG_OPEN_OPTIONS" });
    });

    const modeSel = panel.querySelector(".nig-mode-sel");
    const before = panel.querySelector(".nig-before");
    const after = panel.querySelector(".nig-after");
    const bufRow = panel.querySelector(".nig-bufrow");
    modeSel.value = prefs.mode;
    before.value = prefs.bufferBeforeMin;
    after.value = prefs.bufferAfterMin;
    const reflectMode = () => { bufRow.style.display = prefs.mode === "calendar" ? "" : "none"; };
    reflectMode();

    modeSel.addEventListener("change", () => {
      prefs.mode = modeSel.value === "manual" ? "manual" : "calendar";
      reflectMode();
      chrome.storage.sync.set({ mode: prefs.mode });
      setStatus(prefs.mode === "manual"
        ? "Manual mode: the whole window below counts as available. Set it in Settings."
        : "Calendar mode: free slots become available.", "");
    });
    const saveBuf = () => {
      prefs.bufferBeforeMin = clampInt(before.value, 0, 120);
      prefs.bufferAfterMin = clampInt(after.value, 0, 120);
      chrome.storage.sync.set({
        bufferBeforeMin: prefs.bufferBeforeMin,
        bufferAfterMin: prefs.bufferAfterMin,
      });
    };
    before.addEventListener("change", saveBuf);
    after.addEventListener("change", saveBuf);

    setStatus("Ready. Click “Fill my availability” to draft it.", "");
  }

  /* --------------------------------------- popup -> content messaging -- */

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (panel && msg.type && msg.type.startsWith("NIG_")) panel.style.display = ""; // re-show if dismissed
    if (msg.type === "NIG_FILL") { runFill(); sendResponse({ ok: true }); }
    else if (msg.type === "NIG_CLEAR") { runClear(); sendResponse({ ok: true }); }
    else if (msg.type === "NIG_OVERLAY_TOGGLE") { sendResponse({ ok: setOverlay(!overlayOn) }); }
    else if (msg.type === "NIG_PING") {
      sendResponse({ ok: true, hasGrid: adapter.detect(), site: adapter.id, siteName: adapter.siteName });
    }
    return true;
  });

  /* --------------------------------------------------------- bootstrap -- */
  // Some grids (when2meet's) only exist once you've signed in to the event, so
  // keep watching the DOM until one shows up rather than giving up at load.

  function start() {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      prefs = { ...DEFAULTS, ...stored };
      buildPanel();
    });
  }

  if (adapter.detect()) {
    start();
  } else {
    const obs = new MutationObserver(() => {
      if (!adapter.detect()) return;
      obs.disconnect();
      start();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
