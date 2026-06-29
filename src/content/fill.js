/*  nowisgood - content script (runs on whenisgood.net respond pages)
 *
 *  WhenIsGood respond grid, as reverse-engineered from respond.js:
 *    - <table id="grid"> of <td> cells
 *    - each selectable slot cell has a numeric id = slot-start in epoch MILLIS
 *      e.g. <td class="proposed" id="1785232800000">
 *    - className encodes the response:
 *        "proposed"  -> offered, not picked (the default / unselected state)
 *        "canDo"     -> I'm free
 *        "canDoGood" -> I'm free and this is preferred
 *        "canDoBad"  -> I can do it but it's tight / not ideal
 *    - the page's own submitForm() harvests cells by className into hidden
 *      fields, so we just set className directly and let the user hit SEND.
 *
 *  We therefore never synthesize mouse events: we read the slots, ask the
 *  background worker for calendar events, classify each slot, and paint the
 *  classNames. The user reviews/tweaks and submits normally.
 */
(() => {
  "use strict";

  const grid = document.getElementById("grid");
  // Only act on an actual respond grid (skip homepage, results, etc.).
  const slotCells = grid
    ? [...grid.querySelectorAll("td[id]")].filter((td) => /^\d{10,}$/.test(td.id))
    : [];
  if (!slotCells.length) return;

  const MIN = 60000;
  const DEFAULTS = {
    providerId: "google",
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    durationOverrideMin: 0, // 0 = infer slot length from the grid
    calendarIds: ["primary"],
    allDayBusy: false, // treat all-day events as busy?
    skipDeclined: true, // ignore events you've declined
    markTightAsBad: true, // free-but-buffer-violated -> canDoBad
    preferredEnabled: false, // mark fully-free slots in a window as canDoGood
    preferredStartHour: 9,
    preferredEndHour: 17,
    showPanel: true,
  };

  let prefs = { ...DEFAULTS };
  let lastClassified = null; // cached classification for the overlay
  let overlayOn = false;

  /* --------------------------------------------------- timezone model -- *
   * WhenIsGood encodes each slot's id as its wall-clock time stamped as UTC,
   * and the visible label ("10:00 am") is that UTC reading. The slot actually
   * means that clock time in the VIEWER's local zone, so the real instant is
   * the id's UTC fields re-read as local time. Building the Date from local
   * fields applies the correct DST offset for that calendar date automatically.
   * Verified live: id 1785232800000 shows "10:00 am" and means 10:00 local.    */

  function slotInstant(idMs) {
    const u = new Date(idMs);
    return new Date(
      u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
      u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()
    ).getTime();
  }

  function localTzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; }
    catch (_) { return "local time"; }
  }

  // Sanity check: does the cell's visible label match our naive-UTC reading of
  // its id? If a poll were server-localized the labels would diverge and our
  // instants would be wrong -- in that case we warn rather than silently misfill.
  function labelMatchesId(slot) {
    const m = (slot.td.textContent || "").trim().toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (!m) return null; // unparseable -> can't judge
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === "pm") h += 12;
    const u = new Date(slot.idMs);
    return h === u.getUTCHours() && parseInt(m[2], 10) === u.getUTCMinutes();
  }

  /* ------------------------------------------------------ slot geometry -- */

  function getSlots() {
    return slotCells.map((td) => {
      const idMs = parseInt(td.id, 10);
      return { td, idMs, startMs: slotInstant(idMs) };
    });
  }

  // Smallest positive gap between distinct slot starts == the grid increment.
  // Uses the raw ids (uniform) rather than DST-adjusted instants.
  function inferSlotLengthMs(slots) {
    const starts = [...new Set(slots.map((s) => s.idMs))].sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < starts.length; i++) {
      const d = starts[i] - starts[i - 1];
      if (d > 0 && d < gap) gap = d;
    }
    return isFinite(gap) ? gap : 30 * MIN;
  }

  /* ----------------------------------------------------- busy detection -- */

  function busyIntervals(events) {
    return events
      .filter((e) => {
        if (e.status === "cancelled") return false;
        if (e.transparency === "transparent") return false; // shown as Free
        if (prefs.skipDeclined && e.responseStatus === "declined") return false;
        if (e.allDay && !prefs.allDayBusy) return false;
        return true;
      })
      .map((e) => ({ start: e.startMs, end: e.endMs, summary: e.summary }));
  }

  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

  // Classify every slot -> { td, startMs, endMs, state, conflict }
  // state in: "free" | "tight" | "busy"
  function classify(events) {
    const slots = getSlots();
    const slotLen = prefs.durationOverrideMin > 0 ? prefs.durationOverrideMin * MIN : inferSlotLengthMs(slots);
    const before = prefs.bufferBeforeMin * MIN;
    const after = prefs.bufferAfterMin * MIN;
    const busy = busyIntervals(events);

    return slots.map(({ td, startMs }) => {
      const endMs = startMs + slotLen;
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
      return { td, startMs, endMs, state, conflict };
    });
  }

  function isPreferred(startMs) {
    if (!prefs.preferredEnabled) return false;
    const h = new Date(startMs).getHours();
    return h >= prefs.preferredStartHour && h < prefs.preferredEndHour;
  }

  /* --------------------------------------------------------- paint grid -- */

  function resetGrid() {
    for (const td of slotCells) td.className = "proposed";
  }

  function applyClassification(classified) {
    resetGrid();
    let free = 0, tight = 0, busy = 0;
    for (const c of classified) {
      if (c.state === "busy") { busy++; continue; } // leave as "proposed"
      if (c.state === "tight") { c.td.className = "canDoBad"; tight++; continue; }
      c.td.className = isPreferred(c.startMs) ? "canDoGood" : "canDo";
      free++;
    }
    return { free, tight, busy, total: classified.length };
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
      const r = classified[i].td.getBoundingClientRect();
      const m = markers[i];
      m.style.left = r.left + window.scrollX + "px";
      m.style.top = r.top + window.scrollY + "px";
      m.style.width = r.width + "px";
      m.style.height = r.height + "px";
    }
  }

  function setOverlay(on) {
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

  async function runFill() {
    setStatus("Reading your calendar...", "busy");
    const slots = getSlots();
    const slotLen = prefs.durationOverrideMin > 0 ? prefs.durationOverrideMin * MIN : inferSlotLengthMs(slots);
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
        interactive: true,
      });
    } catch (e) {
      return setStatus("Messaging error: " + e.message, "error");
    }
    if (!resp || !resp.ok) {
      const msg = resp ? resp.error : "no response";
      if (/no token|OAuth2 not granted|not signed/i.test(msg)) {
        return setStatus("Not connected. Open Options to connect Google Calendar.", "error");
      }
      return setStatus("Calendar error: " + msg, "error");
    }

    const classified = classify(resp.events);
    lastClassified = classified;
    const stats = applyClassification(classified);
    if (overlayOn) buildOverlay(classified);

    // Confirm our timezone model holds for this poll before trusting the fill.
    const checks = slots.map(labelMatchesId).filter((v) => v !== null);
    const mismatched = checks.filter((v) => v === false).length;
    const tz = localTzName();
    if (mismatched > 0) {
      setStatus(
        `Filled, but ${mismatched} grid times don't match your local zone (${tz}) ` +
        `— this poll may use a fixed timezone. Double-check before sending.`,
        "error"
      );
    } else {
      setStatus(
        `Filled in ${tz}: ${stats.free} free, ${stats.tight} tight, ${stats.busy} busy. ` +
        `Review and tweak, then SEND.`,
        "ok"
      );
    }
  }

  function runClear() {
    resetGrid();
    lastClassified && setOverlay(false);
    lastClassified = null;
    setStatus("Cleared. All slots reset to unselected.", "ok");
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
        <button class="nig-x" title="Hide panel">×</button>
      </div>
      <div class="nig-body">
        <div class="nig-row nig-buttons">
          <button class="nig-btn nig-btn-fill">Fill from calendar</button>
          <button class="nig-btn nig-btn-clear" title="Reset all slots">Clear</button>
        </div>
        <div class="nig-row">
          <label class="nig-buf">Buffer before
            <input type="number" min="0" max="120" step="5" class="nig-before"> min</label>
          <label class="nig-buf">after
            <input type="number" min="0" max="120" step="5" class="nig-after"> min</label>
        </div>
        <div class="nig-row nig-buttons">
          <button class="nig-btn nig-btn-overlay" title="Translucent calendar overlay (click-through)">Overlay</button>
          <button class="nig-btn nig-btn-gear" title="Settings">⚙ Settings</button>
        </div>
        <div class="nig-status"></div>
        <div class="nig-support">
          <span class="nig-heart">♥</span> nowisgood just fills it in — the real magic is
          <b>WhenIsGood</b>. Its creator keeps it free (try to
          <a href="https://whenisgood.net/YourAccount?upgrade=true" target="_blank" rel="noopener">buy premium</a>
          and it just says <i>“it's always free”</i>). The least we can do is
          <a href="https://whenisgood.net/ContactUs" target="_blank" rel="noopener">say thanks</a>.
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // × dismisses the panel entirely. Bring it back via the toolbar popup
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

    const before = panel.querySelector(".nig-before");
    const after = panel.querySelector(".nig-after");
    before.value = prefs.bufferBeforeMin;
    after.value = prefs.bufferAfterMin;
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

    setStatus("Ready. Click “Fill from calendar” to draft your availability.", "");
  }

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));

  /* --------------------------------------- popup -> content messaging -- */

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (panel && msg.type && msg.type.startsWith("NIG_")) panel.style.display = ""; // re-show if dismissed
    if (msg.type === "NIG_FILL") { runFill(); sendResponse({ ok: true }); }
    else if (msg.type === "NIG_CLEAR") { runClear(); sendResponse({ ok: true }); }
    else if (msg.type === "NIG_OVERLAY_TOGGLE") { sendResponse({ ok: setOverlay(!overlayOn) }); }
    else if (msg.type === "NIG_PING") { sendResponse({ ok: true, hasGrid: true }); }
    return true;
  });

  /* --------------------------------------------------------- bootstrap -- */

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    prefs = { ...DEFAULTS, ...stored };
    buildPanel();
  });
})();
