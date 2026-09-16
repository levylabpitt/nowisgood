/*  nowisgood - the single source of truth for the preferences schema.
 *
 *  Loaded before core.js in every content script (see manifest content_scripts)
 *  and before options.js on the settings page, so the in-page panel, the fill
 *  logic and the options UI all read ONE definition instead of hand-synced
 *  copies. Attaches to the global the same way the site adapters attach to
 *  window.__NIG_ADAPTERS: content scripts of one extension share an isolated
 *  world, so a global set here is visible to core.js loaded after it.
 *
 *  Add or rename a setting HERE and nowhere else.
 */
(function () {
  var DEFAULTS = {
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
  var root =
    (typeof self !== "undefined" && self) ||
    (typeof window !== "undefined" && window) ||
    (typeof globalThis !== "undefined" && globalThis);
  root.NIG_DEFAULTS = DEFAULTS;
})();
