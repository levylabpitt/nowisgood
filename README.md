# ⚡ nowisgood

A Chrome extension that draft-fills group-scheduling grids from your calendar, so
you don't have to click out every free slot by hand. It reads the proposed times,
checks them against your Google Calendar, and marks the slots you're free —
including optional buffers between meetings.

Supported sites:

| Site | How it fills | Submitting |
|---|---|---|
| [WhenIsGood](https://whenisgood.net) | four marks: free, preferred, "if needed", unselected | you press **SEND RESPONSE** |
| [when2meet](https://www.when2meet.com) | binary available / not available | when2meet saves as you go |
| [Rallly](https://rallly.co) | three votes: Yes / If need be / No | you press **Continue** on the poll |

Bonus: a **click-through overlay** that tints every slot (green = free, amber = tight,
red = busy with the conflicting event's name, grey = outside your hours) so you can
eyeball your week and trim before submitting. It's invisible to clicks, so the grid
stays fully usable underneath.

## What it does

- **Fill from calendar** — marks every proposed slot you're free.
- **Manual mode** — mark a fixed weekly window with no calendar and no sign-in at all.
- **Buffers** — set minutes before/after meetings. Slots that touch a meeting inside the
  buffer get the site's own "if needed" mark where one exists — `canDoBad` on WhenIsGood,
  **If need be** on Rallly. when2meet's grid is binary, so there they're simply left
  unavailable.
- **Hours window** — a hard filter, in your local time: a free 2 a.m. slot is never
  offered. In manual mode this window *is* your availability.
- **Preferred hours** (optional) — a soft highlight. Free slots inside the window get
  WhenIsGood's green "preferred" mark (`canDoGood`); on when2meet they're just available.
- **Full sync** — also *clear* slots you're busy for, so the grid matches your calendar.
  Turn it off to only ever raise your availability, never lower it.
- **Overlay** (optional) — translucent, click-through calendar summary over the grid.
- Nothing is auto-submitted. On WhenIsGood it only sets the same cell states you'd set by
  clicking, and WhenIsGood's own **SEND RESPONSE** button does the submitting. On when2meet
  it drives the site's own drag handlers, so the site saves it exactly as if you'd dragged.
  On Rallly it sets your votes and stops — you review them and press **Continue**.

## Calendar providers

- **homegate (localhost)** — talks to your local [homegate](https://github.com/jlevylab/homegate)
  service, which already holds your token. No per-app Google setup.
- **Google Calendar** — in-extension OAuth, read-only.
- **Exchange / Outlook** — stubbed behind the same provider interface in
  `src/background.js`; wire it to Microsoft Graph `/me/calendarView` to enable.

The active provider is chosen in **Settings**.

---

## One-time setup

The extension ships with a fixed key, so it always loads with this **extension ID**:

```
nkngmlfjiogcjohldpflnjafdknmclfd
```

That stable ID is what makes the Google OAuth step a one-time thing.

### 1. Create a Google OAuth client

Skip this entirely if you use the **homegate** provider or **manual mode**.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick)
   a project.
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen:** set up an *External* app, add yourself as a
   **Test user** (your `@levylab.org` / Google account). You can leave it in "Testing"
   mode; no verification needed for personal use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Chrome Extension** (older consoles call it "Chrome App").
   - Item / Application ID: `nkngmlfjiogcjohldpflnjafdknmclfd`
5. Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`) into the
   `oauth2.client_id` field in `manifest.json`.

### 2. Load the extension

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this `nowisgood` folder.
4. Confirm the ID reads `nkngmlfjiogcjohldpflnjafdknmclfd`. (If it doesn't, the `key` in
   `manifest.json` was changed — the OAuth client must match whatever ID Chrome shows.)

### 3. Connect and use

1. Click the nowisgood toolbar icon → **Connect Google** (or do it from **Settings**).
   Approve the read-only calendar scope.
2. In **Settings**, tick which calendars count as "busy" and set your buffers, hours and
   preferences.
3. Open a WhenIsGood respond page (`whenisgood.net/<code>`), a when2meet event, or a Rallly
   invite (`app.rallly.co/invite/<id>`). A small panel appears top-right. Click **Fill my
   availability**, tweak, toggle the **Overlay** if you like — then finish the way that site
   expects (see the table above).

Two per-site preconditions, both checked before anything is changed:

- **when2meet** — sign in to the event first (type your name, and password if it has one)
  so your editable grid appears. Otherwise the grid would look filled and save nothing.
- **Rallly** — open your response row first (press **Continue** / click into the vote row)
  so the vote buttons exist.

---

## Settings reference

| Setting | What it does |
|---|---|
| Fill from | Calendar (free slots become available) or Manual window (no calendar, no sign-in). |
| Provider | homegate, Google Calendar, or Exchange (once implemented). |
| Use every calendar | Ignore the checkbox list and use your whole calendar list, including ones you add later. |
| Calendars to treat as busy | Otherwise, only checked calendars block availability. |
| Buffer before / after | Minutes of padding around each meeting. |
| Assumed slot length | `0` infers the slot length from the grid spacing; override if the meeting is longer than the grid increment. |
| Treat all-day events as busy | Off by default (birthdays etc. shouldn't block you); turn on if you use all-day "Out of office". |
| …but only on calendars I own or can edit | On by default. Keeps subscribed Holidays/Birthdays calendars from blanking whole days. |
| Ignore events I've declined | On by default. |
| Mark buffer-violating slots as "if needed" | WhenIsGood: `canDoBad`. Rallly: **If need be**. when2meet: left unavailable. |
| Hours I'm willing to meet | Hard day/hour filter in your local time. |
| Preferred hours | Soft highlight for free slots inside a window (`canDoGood` on WhenIsGood; no equivalent on when2meet or Rallly). |
| Full sync | Also clear slots you're busy for. On Rallly this means never lowering an existing vote when off. |
| Show floating panel | Toggle the in-page control panel. |

## Privacy

- Calendar access is **read-only** and used only in your browser to classify slots.
- Nothing is sent anywhere except your calendar provider's own API (to read your events).
  The extension has no server.
- Your token stays in the browser's identity store; the page and content scripts only
  ever receive busy intervals, never your token.
- The scheduling site only ever receives the same availability you'd submit by hand.

## Project layout

```
manifest.json
src/
  defaults.js               the preferences schema + defaults (one source of truth)
  background.js              OAuth + calendar providers (Google, homegate, Exchange stub)
  content/
    core.js                  prefs, busy detection, classification, panel, overlay
    panel.css                panel + overlay styling
    sites/
      whenisgood.js          WhenIsGood grid adapter
      when2meet.js           when2meet grid adapter
      rallly.js              Rallly vote adapter
    bridge/
      when2meet-main.js      MAIN-world shim, reads when2meet's window.UserID
  popup/                     toolbar popup (mirror of the panel)
  options/                   settings page
icons/                       16 / 48 / 128 px
```

### Adding another site

`core.js` holds everything site-agnostic; a site adapter is one object registered on
`window.__NIG_ADAPTERS`, implementing `detect`, `slots`, `ensureReady`, `paint`, `clear`,
`verify` and `supportNote`, plus a `caps` block declaring how expressive the grid is
(`tight`, `preferred`, `autosaves`, `canClear`, `overlay`, and the `submitHint` shown
after a fill).
`src/content/sites/whenisgood.js` is the reference implementation and the full contract
is documented at the top of `core.js`. Add the adapter to `content_scripts` in the
manifest (adapter first, `core.js` last — they share one isolated world).

## Timezones

The two sites encode slots differently, so each adapter owns its own conversion:

- **WhenIsGood** has two encodings, and the adapter detects which by sampling the grid.
  On a **legacy** poll the slot id is its **wall-clock time stamped as UTC** and the visible
  label ("10:00 am") is that UTC reading; the slot means that clock time in **your own local
  timezone**, so the adapter re-reads the id's UTC fields as a local instant (DST-correct for
  the date). On a **timezone-enabled** poll (the ones with a "Your Time Zone" selector) the id
  is already a **true epoch instant** and the labels are rendered in the selected zone, so the
  id is used directly. The adapter picks the mode by comparing labels to the id's UTC reading —
  all matching is legacy, a uniform offset is a timezone poll — and only warns when a single
  grid mixes the two inconsistently.
- **when2meet** encodes slots as true epoch seconds, so they're absolute instants and need
  no correction — the fill is correct even when the event's display timezone isn't yours.
- **Rallly** states each option's wall-clock time in the viewer's own timezone, so the
  parsed time is already the right instant. If you change the poll's display timezone in
  Rallly's own UI, fill again afterwards so the labels and your calendar agree.

Your calendar events are absolute instants in both cases, so once the slot instant is
right the comparison is exact. The hours window and preferred hours are evaluated in your
browser's local zone.

## Notes & limitations

- WhenIsGood loads jQuery 1.4 and inline handlers; the adapter only sets cell classes and
  never depends on their internals beyond the documented `id`/`class` contract.
- when2meet has no documented API either: the adapter reads `[id^="YouTime"]` cells and
  synthesizes the same mousedown/mouseover/mouseup the site's own drag produces. Its
  add-vs-erase mode comes from the first cell in a run, which is why marking and clearing
  happen in two separate passes.
- Rallly exposes no time data in the DOM at all, so its adapter parses each vote button's
  `aria-label` ("12 Mar 2026, 9:00 AM – 9:30 AM, Yes"). That depends on Rallly's English
  locale: options it can't read are left untouched and reported, and if it can't read *any*
  of them it changes nothing and says so. Rallly also replaces the button node on every
  click, so each option is re-found by its date/time key between clicks.
- Rallly self-hosted on your own domain won't match the manifest's `rallly.co` hosts. Add
  your domain to `host_permissions` and the Rallly `content_scripts` entry to use it there.
- Google OAuth in "Testing" mode issues refresh tokens that expire after 7 days of
  inactivity — just click **Connect** again if a fill says you're not connected.
