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

  // Drive when2meet's paint handlers across a run of cells that all need the
  // SAME change -- the add/erase mode comes from the first cell's state.
  function paintRun(list) {
    if (!list.length) return;
    fire(list[0], "mousedown");
    for (const c of list) fire(c, "mouseover");
    fire(list[list.length - 1], "mouseup");
    fire(document.body, "mouseup");
  }

  (window.__NIG_ADAPTERS = window.__NIG_ADAPTERS || []).push({
    id: "when2meet",
    siteName: "when2meet",
    rawUnitMs: 1000, // ids are epoch seconds

    caps: {
      states: 2,       // binary available / not available
      autosaves: true, // when2meet persists each painted run
      needsSignIn: true,
      canClear: true,
      overlay: true,
    },

    detect() {
      return cells().length > 0;
    },

    slots() {
      return cells().map((cell) => {
        const raw = slotSeconds(cell);
        return { cell, raw, startMs: raw * 1000 };
      });
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
    paint(classified, opts) {
      const wanted = (c) => c.state === "free";
      const on = [];
      const off = [];
      for (const c of classified) {
        const currentlyOn = isOn(c.cell);
        if (wanted(c) && !currentlyOn) on.push(c.cell);
        else if (!wanted(c) && currentlyOn && opts.overwrite) off.push(c.cell);
      }
      paintRun(on);
      if (opts.overwrite) paintRun(off);
      return { marked: on.length, cleared: off.length };
    },

    clear() {
      const on = cells().filter(isOn);
      paintRun(on);
      return { cleared: on.length };
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
