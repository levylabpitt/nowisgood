/*  nowisgood - background service worker
 *
 *  Owns everything that needs OAuth or cross-origin fetch:
 *    - signing in / out of the calendar provider
 *    - listing the user's calendars
 *    - pulling events in a time window
 *
 *  Providers are pluggable. Google Calendar is implemented; an Exchange /
 *  Microsoft Graph provider can be dropped in behind the same interface.
 *  The active provider is chosen in Options and stored in chrome.storage.
 *
 *  The content script and the popup talk to this worker via chrome.runtime
 *  messages and never touch OAuth tokens directly.
 */

const PROVIDERS = {};

/* ---------------------------------------------------------------- Google -- */

const GoogleProvider = {
  id: "google",

  // Resolve an OAuth token via Chrome's identity service. `interactive`
  // controls whether Chrome may pop the consent/account chooser.
  getToken(interactive) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError;
        if (err || !token) return reject(new Error(err ? err.message : "no token"));
        resolve(token);
      });
    });
  },

  // Drop a token Chrome has cached (used after a 401 so the next call re-mints).
  removeToken(token) {
    return new Promise((resolve) => {
      if (!token) return resolve();
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  },

  async signIn() {
    const token = await this.getToken(true);
    return { ok: true, token: !!token };
  },

  async signOut() {
    // Revoke + clear the cached token so the next sign-in starts clean.
    try {
      const token = await this.getToken(false);
      if (token) {
        await fetch("https://oauth2.googleapis.com/revoke?token=" + token, { method: "POST" });
        await this.removeToken(token);
      }
    } catch (_) { /* nothing cached */ }
    return { ok: true };
  },

  // Authenticated fetch with one automatic retry on an expired token.
  async apiFetch(url, interactive) {
    let token = await this.getToken(interactive);
    let res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) {
      await this.removeToken(token);
      token = await this.getToken(interactive);
      res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    }
    if (!res.ok) throw new Error("Google API " + res.status + ": " + (await res.text()).slice(0, 200));
    return res.json();
  },

  async listCalendars(interactive) {
    const data = await this.apiFetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250",
      interactive
    );
    return (data.items || []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary,
      primary: !!c.primary,
      selected: !!c.selected,
      backgroundColor: c.backgroundColor || null,
    }));
  },

  // Pull events from each requested calendar within [timeMin, timeMax].
  // Normalises everything we need for busy-detection and the overlay.
  async listEvents({ timeMin, timeMax, calendarIds }, interactive) {
    const ids = calendarIds && calendarIds.length ? calendarIds : ["primary"];
    const out = [];
    const errors = [];
    for (const calId of ids) {
      const url =
        "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(calId) +
        "/events?singleEvents=true&orderBy=startTime&maxResults=2500" +
        "&timeMin=" + encodeURIComponent(timeMin) +
        "&timeMax=" + encodeURIComponent(timeMax);
      let data;
      try {
        data = await this.apiFetch(url, interactive);
      } catch (e) {
        // Remember the failure; if EVERY calendar fails we surface it below
        // rather than pretending the user is free all day.
        console.warn("nowisgood: calendar fetch failed for", calId, e);
        errors.push(calId + " — " + (e && e.message ? e.message : e));
        continue;
      }
      for (const ev of data.items || []) {
        const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
        const startMs = parseGoogleTime(ev.start);
        const endMs = parseGoogleTime(ev.end);
        if (startMs == null || endMs == null) continue;
        out.push({
          summary: ev.summary || "(busy)",
          startMs,
          endMs,
          allDay,
          transparency: ev.transparency || "opaque", // "transparent" == shown as Free
          status: ev.status || "confirmed",
          responseStatus: selfResponse(ev),
          calendarId: calId,
        });
      }
    }
    // If we got nothing AND at least one calendar errored, that's a real
    // failure (auth/scope/API-disabled) — throw so the UI shows it instead of
    // silently reporting "all free".
    if (!out.length && errors.length) {
      throw new Error(errors.join(" | "));
    }
    return out;
  },
};
PROVIDERS.google = GoogleProvider;

/* -------------------------------------------------- homegate (localhost) -- */
// Talks to the local homegate service instead of doing OAuth in the extension.
// Zero per-app Google setup: homegate already holds your token. Install it from
// github.com/jlevylab/homegate (one-click install.cmd, auto-starts on login).
const GATEWAY_BASE = "http://127.0.0.1:8788";
PROVIDERS.gateway = {
  id: "gateway",
  async _get(pathAndQuery) {
    let res;
    try {
      res = await fetch(GATEWAY_BASE + pathAndQuery);
    } catch (e) {
      throw new Error("homegate not reachable on " + GATEWAY_BASE + ". Install/start it: github.com/jlevylab/homegate");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || ("gateway " + res.status));
    return data;
  },
  async signIn() {
    const h = await this._get("/health");
    if (!h.authed) throw new Error("Gateway is running but not signed in. Run once: node gateway.js login");
    return { ok: true };
  },
  async signOut() { return { ok: true }; },
  async listCalendars() {
    return (await this._get("/calendars")).calendars;
  },
  async listEvents({ timeMin, timeMax, calendarIds }) {
    const qs = new URLSearchParams({
      timeMin, timeMax,
      calendars: (calendarIds && calendarIds.length ? calendarIds : ["primary"]).join(","),
    });
    return (await this._get("/events?" + qs.toString())).events;
  },
};

/* ------------------------------------------------------ Exchange (stub) -- */
// Placeholder so the provider switch in Options has something to point at.
// Implement via Microsoft Graph (/me/calendarView) behind the same methods.
PROVIDERS.exchange = {
  id: "exchange",
  async signIn() { throw new Error("Exchange provider not implemented yet"); },
  async signOut() { return { ok: true }; },
  async listCalendars() { throw new Error("Exchange provider not implemented yet"); },
  async listEvents() { throw new Error("Exchange provider not implemented yet"); },
};

/* --------------------------------------------------------------- helpers -- */

function parseGoogleTime(t) {
  if (!t) return null;
  if (t.dateTime) return new Date(t.dateTime).getTime();
  if (t.date) return new Date(t.date + "T00:00:00").getTime(); // all-day, local midnight
  return null;
}

// The current user's RSVP for an event ("accepted" / "declined" / ...).
function selfResponse(ev) {
  if (Array.isArray(ev.attendees)) {
    const me = ev.attendees.find((a) => a.self);
    if (me && me.responseStatus) return me.responseStatus;
  }
  return "accepted";
}

async function activeProvider() {
  const { providerId } = await chrome.storage.sync.get({ providerId: "google" });
  return PROVIDERS[providerId] || PROVIDERS.google;
}

/* -------------------------------------------------------- message router -- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const provider = await activeProvider();
      switch (msg.type) {
        case "NIG_SIGN_IN":
          return sendResponse(await provider.signIn());
        case "NIG_SIGN_OUT":
          return sendResponse(await provider.signOut());
        case "NIG_LIST_CALENDARS":
          return sendResponse({ ok: true, calendars: await provider.listCalendars(!!msg.interactive) });
        case "NIG_LIST_EVENTS":
          return sendResponse({
            ok: true,
            events: await provider.listEvents(
              { timeMin: msg.timeMin, timeMax: msg.timeMax, calendarIds: msg.calendarIds },
              msg.interactive !== false
            ),
          });
        case "NIG_OPEN_OPTIONS":
          chrome.runtime.openOptionsPage();
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: "unknown message: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // keep the message channel open for the async reply
});
