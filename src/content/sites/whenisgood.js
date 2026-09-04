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

  // Sanity check: does the cell's visible label match our naive-UTC reading of
  // its id? If a poll were server-localized the labels would diverge and our
  // instants would be wrong -- in that case we warn rather than silently misfill.
  function labelMatchesId(slot) {
    const m = (slot.cell.textContent || "").trim().toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (!m) return null; // unparseable -> can't judge
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === "pm") h += 12;
    const u = new Date(slot.raw);
    return h === u.getUTCHours() && parseInt(m[2], 10) === u.getUTCMinutes();
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
      return cells().map((cell) => {
        const raw = parseInt(cell.id, 10);
        return { cell, raw, startMs: slotInstant(raw) };
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
      const checks = slots.map(labelMatchesId).filter((v) => v !== null);
      const mismatched = checks.filter((v) => v === false).length;
      if (!mismatched) return { ok: true, note: "" };
      return {
        ok: false,
        note:
          "Filled, but " + mismatched + " grid times don't match your local zone — " +
          "this poll may use a fixed timezone.",
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
