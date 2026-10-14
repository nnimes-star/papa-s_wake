# Memorial tribute

A continuous, cinematic memorial display for a television, with a guest page where family and friends leave prayers and messages from their phones.

| Page | Address | For |
| --- | --- | --- |
| TV display | `/display` | The television (16:9, ideally 1920 × 1080) |
| Guest page | `/` | Guests, reached by scanning the QR code on the TV |
| Admin panel | `/admin` | You — moderate messages, set the portrait |

Messages are **published automatically**. You can hide, restore or permanently delete any of them from the admin panel, and the TV updates by itself.

## Quick start

Requires **Node 22.13 or newer**. There is nothing to install: the app has no npm dependencies.

```bash
npm start
```

On the first run the console prints your **admin password once** — save it. To choose your own, set `ADMIN_PASSWORD` instead:

```bash
ADMIN_PASSWORD="a long phrase only you know" npm start
```

Then:

1. Open `/admin`, sign in, and expand **Display settings**.
2. **Choose photograph…** to upload your father's portrait (JPEG, PNG or WebP). Optionally add his name and dates for a caption under the portrait.
3. Open `/display` on the television and press **F** (or double-click) for full screen.
4. Scan the QR code with a phone to leave a message.

## Showing it on the television

- Open `/display` in Chrome, Edge or Safari on the TV or a laptop connected to it, then go full screen with **F**. The cursor hides itself, and the screen is kept awake where the browser allows it.
- For an always-on screen, launch the browser in kiosk mode, for example `chrome --kiosk https://your-address/display`.
- The page adapts to other shapes: a non-16:9 screen is letterboxed in the same dark backdrop, and a narrow/portrait screen stacks the portrait above the message without cropping or stretching the face.
- Add `?debug=1` to the address to show a small status line (connection, queue sizes, countdown). It is off by default.

## Getting guests' phones to the guest page

The QR code encodes the guest page address. By default the server works it out from how you opened it (and swaps `localhost` for the computer's network address).

- **Same Wi-Fi at the venue:** run the app on a laptop, open `http://<laptop-address>:3000/display` on the TV, and guests join the same Wi-Fi.
- **Anyone, anywhere (recommended):** host the app online (below). Guests can use mobile data, and relatives who couldn't attend can leave messages too.
- If the QR code shows an address guests can't reach, set the right one in **Admin → Display settings → Guest page address**, or with the `PUBLIC_URL` environment variable.

## Hosting online

Any host that runs Node 22 or Docker works. Two things matter:

1. **Persistent storage.** Messages and the portrait live in `DATA_DIR` (default `./data`). Mount a persistent disk/volume there, or they are lost when the host restarts.
2. **HTTPS.** Use the host's HTTPS address. It also enables the display's offline cache (below).

Using the included Dockerfile:

```bash
docker build -t memorial .
docker run -p 3000:3000 -v memorial-data:/data -e ADMIN_PASSWORD="your password" memorial
```

Set `TRUST_PROXY=1` when the app runs behind a hosting provider's proxy (the Dockerfile does this by default). Without it, every guest looks like the same visitor to the abuse limiter.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Database and portrait location (**needs persistent storage**) |
| `ADMIN_PASSWORD` | generated on first run | Admin password |
| `PUBLIC_URL` | automatic | Address the QR code points to |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy / hosting platform |

To back everything up, copy the `DATA_DIR` folder.

## How it behaves

**Presentation**
- The portrait, background, floating keywords and QR code never change. Only the message area crossfades, every 20 seconds (changeable in the admin settings, 8–120 s). The screen never fades to black.
- Text size adapts to each message so it never clips; messages are limited to 700 characters.
- New messages are queued and appear at the **next** transition — the message on screen is never interrupted. They jump ahead of the normal rotation, so a guest sees their words soon after sending.
- The same message is never shown twice in a row, and each message appears once per cycle.

**Moderation**
- Hide, restore and delete take effect on the TV within about a second. If the hidden message is on screen, the display moves on to the next one without a blank screen.
- `hidden` and `pending` messages are never sent to the display.

**Reliability**
- The TV listens for live updates and also re-checks every 30 seconds.
- If the internet drops, the portrait and every loaded message keep playing. When the connection returns, the display catches up on new messages and moderation changes by itself.
- If the page is reloaded while offline, it restores the last messages and the portrait from its local cache (the service worker needs HTTPS or `localhost`; on plain `http://` over a local network the page simply keeps running, which is the usual case for an open tab).

**Safety**
- Submissions are validated on the server (name ≤ 80, message ≤ 700 characters), invisible/bidirectional control characters are removed, and everything is displayed as plain text.
- A hidden honeypot field, duplicate detection and a per-visitor rate limit deter spam without blocking real guests.
- The admin panel needs a password (signed, HttpOnly, SameSite=Strict cookie; sign-in attempts are rate limited). It is a separate page from the guest page and the TV display.

## Acceptance test

`npm test` runs your exact scenario in a real browser against a throw-away database (it needs Playwright with Chromium and Python's OpenCV to read the QR code; both are development-only):

1. Opens `/display` at 1920 × 1080 and checks the layout proportions.
2. Confirms the portrait stays put while messages change every 20 s.
3. Reads the on-screen QR code and opens the guest page it points to.
4. Submits a message from a phone-sized browser and confirms it is saved, published and queued without interrupting the current message.
5. Hides it from the admin panel while it is on screen.
6. Confirms it leaves immediately, never returns, and the presentation continues.

It also covers restore, simulated internet loss and recovery, reloading while offline, narrow screens, validation, and sign-in security.

## Project layout

```
server.js        HTTP server, SQLite storage, live updates (SSE), admin API
lib/qr.js        QR code → SVG (uses the bundled MIT-licensed encoder in vendor/)
public/          display, guest and admin pages (plain HTML/CSS/JS), service worker
test/            acceptance test
```
