/*  nowisgood - WhenIsGood site adapter (whenisgood.net respond pages)
 *
 *  Grid contract, as reverse-engineered from respond.js:
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
 *  We therefore never synthesize mouse events here: we set classNames exactly
 *  as a human click would. Nothing is auto-submitted.
 */
(() => {
  "use strict";

  function cells() {
    const grid = document.getElementById("grid");
    if (!grid) return [];
    return [...grid.querySelectorAll("td[id]")].filter((td) => /^\d{10,}$/.test(td.id));
  }

  /* --------------------------------------------------- timezone model -- *
   * WhenIsGood has TWO grid encodings, and we detect which from the grid:
   *
   *   legacy       - the id is the slot's wall-clock stamped as UTC, and the
   *                  visible label ("10:00 am") is that same UTC reading. The
   *                  slot means that clock time in the VIEWER's local zone, so
   *                  the real instant is the id's UTC fields re-read as local
   *                  time (slotInstant), DST-correct for that date.
   *   timezone-set - newer polls carry a "Your Time Zone" selector: the id is a
   *                  TRUE epoch instant, and the labels are rendered in the
   *                  selected zone, so they no longer match the id's UTC
   *                  reading. Here the id already IS the real instant.
   *
   * We tell them apart by sampling the cells: compare each visible label to the
   * id's naive-UTC reading. All match -> legacy. A uniform offset -> timezone
   * poll (use the id directly). Verified live on a legacy poll: id 1785232800000
   * shows "10:00 am" and means 10:00 local.                                     */

  function slotInstant(idMs) {
    const u = new Date(idMs);
    return new Date(
      u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
      u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()
    ).getTime();
  }

  // Minutes between a cell's visible time label and the id's naive-UTC reading.
  // 0 on a legacy poll; a constant nonzero (the selected zone's offset) on a
  // timezone poll. null when the label can't be parsed.
  function labelDeltaMin(cell, idMs) {
    const m = (cell.textContent || "").trim().toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    if (m[3]) { h = h % 12; if (m[3] === "pm") h += 12; } // 12-hour label
    // else: a 24-hour label -- use the hour as-is
    const u = new Date(idMs);
    let d = (h * 60 + parseInt(m[2], 10)) - (u.getUTCHours() * 60 + u.getUTCMinutes());
    d = ((d % 1440) + 1440) % 1440; // wrap, then fold into a signed offset
    if (d > 720) d -= 1440;
    return d;
  }

  // Tally label-vs-id agreement across the readable cells.
  function labelTally(cs) {
    let match = 0, diff = 0;
    for (const cell of cs) {
      const d = labelDeltaMin(cell, parseInt(cell.id, 10));
      if (d === null) continue;
      if (d === 0) match++; else diff++;
    }
    return { match, diff };
  }

  // A poll is legacy unless its labels clearly disagree with its ids. No
  // readable labels -> can't tell -> legacy, the long-standing default and the
  // only safe choice for the polls this started on.
  function isLegacy(cs) {
    const { match, diff } = labelTally(cs);
    if (match === 0 && diff === 0) return true;
    return match >= diff;
  }

  (window.__NIG_ADAPTERS = window.__NIG_ADAPTERS || []).push({
    id: "whenisgood",
    siteName: "WhenIsGood",
    rawUnitMs: 1, // ids are already epoch millis

    caps: {
      tight: true,      // canDoBad -- "I can do it, but it's tight"
      preferred: true,  // canDoGood
      autosaves: false, // the user submits with SEND RESPONSE
      needsSignIn: false,
      canClear: true,
      overlay: true,
      submitHint: "Review and tweak, then hit SEND RESPONSE.",
    },

    detect() {
      return cells().length > 0;
    },

    slots() {
      const cs = cells();
      const legacy = isLegacy(cs);
      return cs.map((cell) => {
        const raw = parseInt(cell.id, 10);
        // legacy: id is wall-clock-as-UTC -> rebuild it as a local instant.
        // timezone poll: id is already a true epoch instant -> use it directly.
        return { cell, raw, startMs: legacy ? slotInstant(raw) : raw };
      });
    },

    // The respond page needs no identity: the name field is part of the form
    // the user submits themselves.
    async ensureReady() {
      return { ok: true, message: "" };
    },

    // The whole grid is a draft, so every fill starts from a clean slate --
    // `overwrite` is implicit here and the option only matters on autosaving
    // sites. Buffer-violated slots become canDoBad ("if needed"); slots outside
    // the hours window are simply left unselected.
    paint(classified) {
      for (const td of cells()) td.className = "proposed";
      let marked = 0;
      for (const c of classified) {
        if (c.state === "busy" || c.state === "outside") continue;
        if (c.state === "tight") { c.cell.className = "canDoBad"; marked++; continue; }
        c.cell.className = c.preferred ? "canDoGood" : "canDo";
        marked++;
      }
      return { marked, cleared: 0 };
    },

    clear() {
      const all = cells();
      for (const td of all) td.className = "proposed";
      return { cleared: all.length };
    },

    verify(slots) {
      // Both clean cases are fine: every label matches its id (legacy) OR every
      // label shares one offset from it (timezone poll, already handled in
      // slots()). Only a MIX -- some matching, some not -- means neither reading
      // is clean for the whole grid, so flag that rather than trust a guess.
      let match = 0, diff = 0;
      for (const s of slots) {
        const d = labelDeltaMin(s.cell, s.raw);
        if (d === null) continue;
        if (d === 0) match++; else diff++;
      }
      if (match === 0 || diff === 0) return { ok: true, note: "" };
      return {
        ok: false,
        note:
          "Filled, but " + Math.min(match, diff) + " grid times are inconsistent with the rest — " +
          "this poll's timezone data looks mixed, so double-check before sending.",
      };
    },

    supportNote() {
      return (
        '<span class="nig-heart">&hearts;</span> nowisgood just fills it in — the real magic is ' +
        '<b>WhenIsGood</b>. Its creator keeps it free (try to ' +
        '<a href="https://whenisgood.net/YourAccount?upgrade=true" target="_blank" rel="noopener">buy premium</a> ' +
        'and it just says <i>“it\'s always free”</i>). The least we can do is ' +
        '<a href="https://whenisgood.net/ContactUs" target="_blank" rel="noopener">say thanks</a>.'
      );
    },
  });
})();
