/*  nowisgood - Rallly site adapter (rallly.co / app.rallly.co invite pages)
 *
 *  Rallly isn't a paint grid: each proposed time is a button you vote on, and
 *  the vote cycles Yes -> If need be -> No. There's no id or data attribute
 *  carrying the time, so the only reliable handle is the button's aria-label,
 *  which reads like:
 *
 *      "12 Mar 2026, 9:00 AM – 9:30 AM, Yes"
 *
 *  That gives us start, end and current vote in one string. Two consequences:
 *
 *    - Each option states its OWN length, so this adapter returns endMs per
 *      slot instead of letting core infer one length from the grid spacing --
 *      Rallly polls can propose times of differing durations.
 *    - Parsing depends on Rallly's English locale. Anything we can't parse is
 *      skipped rather than guessed at, and verify() reports the count so a
 *      locale change surfaces as a warning instead of a silent partial fill.
 *
 *  Rallly re-renders the button on every click, so we re-find each option by
 *  its date/time key between clicks rather than holding the node.
 *
 *  Unlike the other two sites, Rallly's three vote states line up exactly with
 *  our own: free -> Yes, tight -> If need be, busy/outside -> No.
 */
(() => {
  "use strict";

  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  // day, month, year, start h:m am/pm, en dash or hyphen, end h:m am/pm, vote
  const LABEL_RE =
    /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*([AP]M)\s*[–—-]\s*(\d{1,2}):(\d{2})\s*([AP]M)\s*,\s*([^,]+)$/i;

  // How available each vote is, so "only ever add availability" can tell an
  // upgrade from a downgrade.
  const RANK = { no: 0, ifneedbe: 1, yes: 2 };

  const normalizeVote = (s) => String(s).trim().toLowerCase().replace(/[\s\-_]+/g, "");

  let skipped = 0; // unparseable vote buttons seen during the last slots() call

  function voteButtons() {
    return [...document.querySelectorAll("button[aria-label]")].filter((b) => {
      const a = b.getAttribute("aria-label") || "";
      // Deliberately looser than the strict parse below: a button that looks
      // like a time option but can't be parsed should surface as a warning, not
      // vanish and read as "no response row open".
      return /\b20\d\d\b/.test(a) && /\d{1,2}:\d{2}/.test(a) && /[–—-]/.test(a);
    });
  }

  function parseLabel(aria) {
    const m = (aria || "").match(LABEL_RE);
    if (!m) return null;
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon == null) return null;
    const sh = (+m[4] % 12) + (m[6].toUpperCase() === "PM" ? 12 : 0);
    const eh = (+m[7] % 12) + (m[9].toUpperCase() === "PM" ? 12 : 0);
    const start = new Date(+m[3], mon, +m[1], sh, +m[5]);
    let end = new Date(+m[3], mon, +m[1], eh, +m[8]);
    if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86400000); // crosses midnight
    return { startMs: start.getTime(), endMs: end.getTime(), vote: normalizeVote(m[10]) };
  }

  // The date + start time, which survives Rallly's re-render of the button.
  function keyOf(aria) {
    const m = (aria || "").match(/(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4},\s*\d{1,2}:\d{2}\s*[AP]M)/i);
    return m ? m[1] : null;
  }

  const keys = new WeakMap(); // button -> key, captured while reading slots

  function findByKey(key) {
    return voteButtons().find((b) => (b.getAttribute("aria-label") || "").includes(key));
  }

  function voteOf(button) {
    const p = parseLabel(button.getAttribute("aria-label") || "");
    return p ? p.vote : "";
  }

  // Click through the cycle until the button reads `target`. Three states means
  // at most three hops; the fourth is a guard against an unexpected cycle.
  async function setVote(key, target) {
    for (let i = 0; i < 4; i++) {
      const el = findByKey(key);
      if (!el) return false;
      if (voteOf(el) === target) return true;
      el.click();
      await new Promise((r) => setTimeout(r, 140)); // let Rallly re-render
    }
    return false;
  }

  (window.__NIG_ADAPTERS = window.__NIG_ADAPTERS || []).push({
    id: "rallly",
    siteName: "Rallly",
    rawUnitMs: 1, // we hand core real millis

    caps: {
      tight: true,      // "If need be" is exactly our tight state
      preferred: false, // no separate preferred vote
      autosaves: false, // votes are set locally until you press Continue
      needsSignIn: false,
      canClear: true,
      overlay: true,
      submitHint: "Votes are set but NOT submitted — review them, then click Continue on the poll.",
    },

    // The poll UI hydrates late, so match on the invite route and let
    // ensureReady() explain if the vote row isn't open yet.
    detect() {
      return /\/invite\//.test(location.pathname);
    },

    slots() {
      skipped = 0;
      const out = [];
      for (const cell of voteButtons()) {
        const aria = cell.getAttribute("aria-label") || "";
        const p = parseLabel(aria);
        const key = keyOf(aria);
        if (!p || !key) { skipped++; continue; }
        keys.set(cell, key);
        out.push({ cell, raw: p.startMs, startMs: p.startMs, endMs: p.endMs });
      }
      return out;
    },

    async ensureReady() {
      const buttons = voteButtons();
      if (!buttons.length) {
        return {
          ok: false,
          message:
            "No open response row found. On the Rallly poll, start your response " +
            "(click into the vote row or press Continue), then fill.",
        };
      }
      // Time options we can see but can't read at all: stop rather than fill in
      // a fraction of the poll and leave the rest silently untouched.
      if (!buttons.some((b) => parseLabel(b.getAttribute("aria-label") || ""))) {
        return {
          ok: false,
          message:
            "Found " + buttons.length + " time option(s) but couldn't read any of them, so nothing " +
            "was changed. Rallly may be showing a language or time format this adapter doesn't parse yet.",
        };
      }
      return { ok: true, message: "" };
    },

    // free -> Yes, tight -> If need be, busy/outside -> No. With full sync off
    // we only ever raise a vote, never lower one.
    async paint(classified, opts) {
      let marked = 0, cleared = 0, unresolved = 0;
      for (const c of classified) {
        const key = keys.get(c.cell);
        if (!key) { unresolved++; continue; }
        const target = c.state === "free" ? "yes" : c.state === "tight" ? "ifneedbe" : "no";
        const current = voteOf(findByKey(key) || c.cell);
        if (current === target) continue;
        if (!opts.overwrite && RANK[target] <= (RANK[current] ?? 0)) continue;
        if (!(await setVote(key, target))) { unresolved++; continue; }
        if (target === "no") cleared++; else marked++;
      }
      skipped += unresolved;
      return { marked, cleared };
    },

    async clear() {
      let cleared = 0;
      for (const cell of voteButtons()) {
        const key = keyOf(cell.getAttribute("aria-label") || "");
        if (!key || voteOf(cell) === "no") continue;
        if (await setVote(key, "no")) cleared++;
      }
      return { cleared };
    },

    // Rallly renders in the viewer's own timezone, so the parsed wall-clock is
    // already the right instant. What can go wrong is the label format itself.
    verify() {
      if (!skipped) return { ok: true, note: "" };
      return {
        ok: false,
        note:
          skipped + " time option(s) couldn't be read and were left untouched — " +
          "Rallly may be showing a language or format this adapter doesn't parse yet.",
      };
    },

    supportNote() {
      return (
        '<span class="nig-heart">&hearts;</span> nowisgood just fills it in — the poll is ' +
        '<b>Rallly</b>, which is open source and self-hostable. ' +
        'If you rely on it, <a href="https://github.com/lukevella/rallly" target="_blank" rel="noopener">star it</a> ' +
        'or <a href="https://support.rallly.co" target="_blank" rel="noopener">back it</a>.'
      );
    },
  });
})();
