/*  nowisgood - when2meet site adapter (when2meet.com event pages)
 *
 *  Grid contract:
 *    - your editable cells are <div id="YouTime<unix seconds>">, sometimes also
 *      carrying data-time with the same value
 *    - a cell is "available" when its computed background is when2meet's green
 *    - there is no submit step: when2meet persists each drag as it happens
 *
 *  So unlike WhenIsGood we can't just set state -- we have to drive when2meet's
 *  own mousedown/mouseover/mouseup handlers so the site saves the change the
 *  same way a drag would. The handler decides add-vs-erase from the first cell
 *  in the run, which is why we paint in two passes over same-direction cells.
 *
 *  Timezones need no correction here: the ids are true epoch seconds, so a slot
 *  is an absolute instant regardless of the event's display timezone.
 */
(() => {
  "use strict";

  const AVAIL_COLOR = "rgb(51, 153, 0)"; // when2meet "you are available" green

  function cells() {
    return [...document.querySelectorAll('[id^="YouTime"]')];
  }

  function slotSeconds(cell) {
    const a = cell.getAttribute("data-time");
    if (a != null && a !== "") return parseInt(a, 10);
    return parseInt(cell.id.replace("YouTime", ""), 10);
  }

  function isOn(cell) {
    return getComputedStyle(cell).backgroundColor === AVAIL_COLOR;
  }

  function cellEntries() {
    return cells().map((cell) => {
      const raw = slotSeconds(cell);
      return { cell, raw, startMs: raw * 1000 };
    });
  }

  // Ask the MAIN-world bridge for when2meet's window.UserID. Resolves 0 if the
  // person hasn't signed in to the event (painting would look right but not save).
  function signedInUserId(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.__nigRes !== "when2meetUserId") return;
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(e.data.userId || 0);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ __nigReq: "when2meetUserId" }, "*");
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(0);
      }, timeoutMs || 900);
    });
  }

  function fire(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }

  // Drive when2meet's paint handlers across a run of cells.
  //
  // IMPORTANT: when2meet fills the whole REGION between the anchor cell and the
  // last cell the drag reaches -- it does not paint each cell that happens to
  // receive a mouseover. Passing a scattered selection therefore fills every
  // slot between the first and last, which is how a fill once marked a whole
  // grid available. Only ever hand this a set of cells that form one solid
  // block in the grid: a contiguous time range within a single day column.
  function paintRun(list) {
    if (!list.length) return;
    fire(list[0], "mousedown");
    for (const c of list) fire(c, "mouseover");
    fire(list[list.length - 1], "mouseup");
    fire(document.body, "mouseup");
  }

  // A single cell is a 1x1 region, so this is safe whatever the site's drag
  // semantics turn out to be. Used to repair anything the run-based pass got
  // wrong. Toggles, so only call it on a cell that is in the wrong state.
  function paintCell(cell) {
    fire(cell, "mousedown");
    fire(cell, "mouseover");
    fire(cell, "mouseup");
    fire(document.body, "mouseup");
  }

  // The grid increment, from the smallest positive gap between slot starts.
  function slotLengthOf(entries) {
    const starts = [...new Set(entries.map((e) => e.startMs))].sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < starts.length; i++) {
      const d = starts[i] - starts[i - 1];
      if (d > 0 && d < gap) gap = d;
    }
    return isFinite(gap) ? gap : 15 * 60000;
  }

  // Split cells needing the same change into solid blocks: same calendar day,
  // consecutive slot starts. Each block is one column of the grid, which is
  // exactly the gesture a person makes when dragging down a day.
  function solidBlocks(entries, slotLen) {
    const sorted = [...entries].sort((a, b) => a.startMs - b.startMs);
    const blocks = [];
    let run = [];
    for (const e of sorted) {
      if (!run.length) { run = [e]; continue; }
      const prev = run[run.length - 1];
      const sameDay =
        new Date(prev.startMs).toDateString() === new Date(e.startMs).toDateString();
      if (sameDay && e.startMs - prev.startMs === slotLen) run.push(e);
      else { blocks.push(run); run = [e]; }
    }
    if (run.length) blocks.push(run);
    return blocks;
  }

  (window.__NIG_ADAPTERS = window.__NIG_ADAPTERS || []).push({
    id: "when2meet",
    siteName: "when2meet",
    rawUnitMs: 1000, // ids are epoch seconds

    caps: {
      tight: false,    // binary grid: available or not, nothing in between
      preferred: false,
      autosaves: true, // when2meet persists each painted run
      needsSignIn: true,
      canClear: true,
      overlay: true,
      submitHint: "when2meet saves automatically.",
    },

    detect() {
      return cells().length > 0;
    },

    slots() {
      return cellEntries();
    },

    async ensureReady() {
      if (!cells().length) {
        return {
          ok: false,
          message: "No editable grid found. Type your name into the when2meet to sign in to the event, then fill.",
        };
      }
      const uid = await signedInUserId();
      if (!uid) {
        return {
          ok: false,
          message:
            "You're not signed in to this event yet — type your name (and password, if it has one) and click Sign In " +
            "on the when2meet, then fill. Otherwise the grid looks filled but nothing saves.",
        };
      }
      return { ok: true, message: "" };
    },

    // Binary grid: "tight" (buffer-violated) and "outside" both count as NOT
    // available, which is the conservative reading -- a slot that brushes a
    // meeting shouldn't be offered as free when there's no "if needed" mark.
    //
    // Painting happens in solid per-day blocks (see paintRun), then the grid is
    // read back and anything still wrong is repaired cell by cell. The readback
    // is the part that matters: it means a wrong assumption about the site's
    // drag behaviour shows up as a corrected count or an honest error, never as
    // a silently mis-filled poll.
    async paint(classified, opts) {
      const want = (c) => c.state === "free";
      const expected = new Map();
      const toOn = [];
      const toOff = [];
      for (const c of classified) {
        const on = isOn(c.cell);
        const w = want(c);
        expected.set(c.cell, w ? true : opts.overwrite ? false : on);
        if (w && !on) toOn.push(c);
        else if (!w && on && opts.overwrite) toOff.push(c);
      }

      const slotLen = slotLengthOf(classified);
      for (const block of solidBlocks(toOn, slotLen)) paintRun(block.map((e) => e.cell));
      if (opts.overwrite) {
        for (const block of solidBlocks(toOff, slotLen)) paintRun(block.map((e) => e.cell));
      }

      // Readback. Repair one cell at a time; a 1x1 region can't overshoot.
      let corrected = 0;
      for (const c of classified) {
        if (isOn(c.cell) === expected.get(c.cell)) continue;
        paintCell(c.cell);
        corrected++;
      }
      const stillWrong = classified.filter((c) => isOn(c.cell) !== expected.get(c.cell)).length;

      return { marked: toOn.length, cleared: toOff.length, corrected, stillWrong };
    },

    async clear() {
      const cells = cellEntries();
      const on = cells.filter((e) => isOn(e.cell));
      for (const block of solidBlocks(on, slotLengthOf(cells))) paintRun(block.map((e) => e.cell));
      let stillWrong = 0;
      for (const e of cells) {
        if (!isOn(e.cell)) continue;
        paintCell(e.cell);
        if (isOn(e.cell)) stillWrong++;
      }
      return { cleared: on.length, stillWrong };
    },

    // Slot ids are absolute instants, so there's no timezone model to check.
    verify() {
      return { ok: true, note: "" };
    },

    supportNote() {
      return (
        '<span class="nig-heart">&hearts;</span> nowisgood just fills it in — the scheduling is all ' +
        '<b>when2meet</b>, which its creator has kept free and ad-light for years. ' +
        'If it saves you time, <a href="https://www.when2meet.com/?donate" target="_blank" rel="noopener">chip in</a>.'
      );
    },
  });
})();
