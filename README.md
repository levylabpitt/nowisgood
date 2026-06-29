# ⚡ nowisgood

A Chrome extension that draft-fills [WhenIsGood](https://whenisgood.net) availability
grids from your calendar, so you don't have to click out every free slot by hand.
It reads the proposed times, checks them against your Google Calendar, and paints the
slots you're free, including optional buffers between meetings. You then tweak and hit
**SEND** as usual.

Bonus: a **click-through overlay** that tints every slot (green = free, amber = tight,
red = busy, with the conflicting event's name) so you can eyeball your week and trim
before submitting. It's invisible to clicks, so the grid stays fully usable underneath.

## What it does

- **Fill from calendar** — marks every proposed slot you're free as "can do".
- **Buffers** — set minutes before/after meetings; slots that touch a meeting inside the
  buffer are marked "if needed" (`canDoBad`) rather than fully free.
- **Preferred hours** (optional) — free slots inside your preferred window get the green
  "preferred" mark (`canDoGood`).
- **Overlay** (optional) — translucent, click-through calendar summary over the grid.
- Nothing is auto-submitted. It only sets the same cell states you'd set by clicking;
  WhenIsGood's own **SEND RESPONSE** button does the submitting.

How it works under the hood: each WhenIsGood slot cell is a `<td>` whose `id` is the
slot start time in epoch milliseconds, and whose `class` encodes your response. The
extension just sets those classes, exactly as a human click would. No scraping of other
people's responses, no automated submission.

## Calendar providers

- **Google Calendar** — implemented (OAuth, read-only).
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

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick)
   a project.
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen:** set up an *External* app, add yourself as a
   **Test user** (your `@levylab.org` / Google account). You can leave it in "Testing"
   mode; no verification needed for personal use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Chrome Extension** (older consoles call it "Chrome App").
   - Item / Application ID: `nkngmlfjiogcjohldpflnjafdknmclfd`
5. Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`).

### 2. Drop the client ID into the manifest

In `manifest.json`, replace the placeholder:

```json
"oauth2": {
  "client_id": "REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/calendar.readonly"]
}
```

### 3. Load the extension

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this `nowisgood` folder.
4. Confirm the ID reads `nkngmlfjiogcjohldpflnjafdknmclfd`. (If it doesn't, the `key` in
   `manifest.json` was changed — the OAuth client must match whatever ID Chrome shows.)

### 4. Connect and use

1. Click the nowisgood toolbar icon → **Connect Google** (or do it from **Settings**).
   Approve the read-only calendar scope.
2. In **Settings**, tick which calendars count as "busy" and set your buffers/preferences.
3. Open any WhenIsGood respond page (`whenisgood.net/<code>`). A small panel appears
   top-right. Click **Fill from calendar**, tweak, toggle the **Overlay** if you like, then
   hit WhenIsGood's **SEND RESPONSE**.

---

## Settings reference

| Setting | What it does |
|---|---|
| Provider | Google Calendar (or Exchange, once implemented). |
| Calendars to treat as busy | Only checked calendars block availability. |
| Buffer before / after | Minutes of padding around each meeting. |
| Assumed slot length | `0` infers the slot length from the grid spacing; override if the meeting is longer than the grid increment. |
| Treat all-day events as busy | Off by default (birthdays etc. shouldn't block you); turn on if you use all-day "Out of office". |
| Ignore events I've declined | On by default. |
| Mark buffer-violating slots as "if needed" | Free slots that touch a meeting inside the buffer become `canDoBad` instead of dropping to busy. |
| Preferred hours | Highlight free slots inside a window as "preferred" (green). |
| Show floating panel | Toggle the in-page control panel. |

## Privacy

- Calendar access is **read-only** and used only in your browser to classify slots.
- Nothing is sent anywhere except Google's own API (to read your events). The extension
  has no server.
- WhenIsGood only ever receives the same availability you'd submit by hand.

## Project layout

```
manifest.json
src/
  background.js          OAuth + calendar providers (Google impl, Exchange stub)
  content/
    fill.js              reads the grid, classifies slots, paints them, overlay, panel
    panel.css            panel + overlay styling
  popup/                 toolbar popup (mirror of the panel)
  options/               settings page
icons/                   16 / 48 / 128 px
```

## Timezones

WhenIsGood encodes each slot id as its **wall-clock time stamped as UTC**, and the
visible label ("10:00 am") is that UTC reading. A slot means that clock time in **your
own local timezone** — so the extension converts each id's UTC fields back into a real
instant in your local zone (DST-correct for that date) before checking your calendar.
Your Google events are absolute instants, so once the slot instant is right the
comparison is exact.

On each fill the extension also cross-checks the visible grid labels against this model;
if a particular poll turns out to use a fixed/shifted timezone (labels not matching),
it tells you in the status line instead of silently mis-filling. "Preferred hours" is
evaluated in the same local zone the grid shows.

## Notes & limitations

- The timezone conversion is verified live against real WhenIsGood polls; see the
  Timezones section above.
- WhenIsGood loads jQuery 1.4 and inline handlers; the extension only sets cell classes and
  never depends on their internals beyond the documented `id`/`class` contract.
- Google OAuth in "Testing" mode issues refresh tokens that expire after 7 days of
  inactivity — just click **Connect** again if a fill says you're not connected.
