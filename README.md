# TickTick Focus — Ulanzi Deck plugin

A single **smart Focus button** for your Ulanzi Deck that controls and mirrors your
TickTick focus/pomodoro timer.

- **Start** a focus session (default 25 min) with one click.
- **Pause / resume** an in-progress focus with the same click.
- When focus ends, the button shows **Relax 5'?** — click to start the break.
- **Mirrors** focus started or paused on another device (Mac, phone) within ~30 s.
- Shows the **live remaining time (MM:SS)** with a progress ring.

The button never ends/abandons a session — that stays a deliberate action in TickTick.

## Install

**One-liner (recommended):**

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/narlei/ulanzideck-ticktick/main/install.sh)"
```

It downloads the latest release, installs it into the UlanziDeck plugins folder,
strips the download quarantine from the native login helper (so Gatekeeper allows
the unsigned binary), and restarts Ulanzi Studio.

**From source:** `make install` compiles the native helper, syncs into
`~/Library/Application Support/Ulanzi/UlanziDeck/Plugins`, and restarts the app.
`make package` produces `dist/com.narlei.ticktickfocus.ulanziPlugin.zip`.

## Setup

Open the button's settings (property inspector) and click **Sign in to TickTick**.
A small native window (macOS WebKit — no Chromium, no download) opens the TickTick
login page. Log in however you normally do — password, Google/Apple, captcha, 2FA;
it's a real browser engine. As soon as the session cookie appears, the window closes
and the token is saved. **Nothing is stored except the session token** — no password.

- **Token expiry:** the session token lasts weeks/months but can eventually expire.
  When it does, the button shows **↻** — just click **Sign in** again.
- **Manual fallback:** under *Advanced*, you can paste the `t` cookie value yourself
  (ticktick.com → dev tools → Application/Storage → Cookies → `t`).
- **Durations:** override focus/break minutes, or leave at `0` to follow your TickTick
  pomodoro preferences.

### Why a native login window instead of email/password fields?

TickTick's web login requires a browser-generated `X-Csrftoken` (plus session
cookies) that a headless request can't reliably forge — a raw email/password POST
gets rejected even with the correct password. Driving the real WebKit engine sidesteps
that entirely: the page generates its own CSRF token and handles captcha/2FA, and we
just read the resulting `t` cookie (WKWebView can read HttpOnly cookies, which page
JavaScript cannot). The token is persisted to
`~/Library/Application Support/TickTickFocus/auth.json`, outside the plugin folder, so
it survives restarts and reinstalls.

## How it works

| Button state | Detected from | Click does | Shows |
|---|---|---|---|
| **Idle** | no active session | start focus (25') | TickTick logo + "Focus" |
| **Focusing** | active, time left | pause | ring + MM:SS (green) |
| **Paused** | session paused | resume | MM:SS + "⏸ Paused" (amber) |
| **Relax?** | focus completed | start break (5') | "Relax 5'?" (cyan) |
| **Break** | break running | pause/resume | MM:SS (cyan) |
| **Login / Reauth / Error** | no/invalid token, network | opens settings / retries | neutral screens |

State is server-authoritative: the plugin polls `ms.ticktick.com/focus/batch/focusOp`
every ~30 s (paused when the key isn't visible) and ticks the countdown locally each
second in between. A click sends the operation, updates the UI optimistically, and
reconciles with the server's returned state.

## Architecture

```
com.narlei.ticktickfocus.ulanziPlugin/
├── manifest.json                 # 1 action "Focus", Type JavaScript, PrivateAPI
├── plugin/
│   ├── app.js                    # lifecycle + state machine + poll (30s) + tick (1s)
│   ├── ticktick-client.js        # signin / getState / sendOp / prefs (all API isolated here)
│   ├── focus-state.js            # derives the logical state from `current` + countdown
│   ├── renderer.js               # SVG → dataURL per state
│   └── plugin-common-node/       # UlanziDeck node SDK
├── property-inspector/           # Sign-in button, status, token fallback, overrides
├── libs/                         # browser-side SDK for the property inspector
├── resources/                    # icon.png, action.png, ticktick-login (native helper)
└── en.json / pt_BR.json          # localized strings

native/ticktick-login.swift       # WKWebView login helper source (compiled into resources/)
install.sh                        # curl|bash installer (de-quarantines the helper)
```

> ⚠️ The TickTick focus endpoints are **private / unofficial** and may change without
> notice. Everything host-specific is isolated in `ticktick-client.js`; failures degrade
> to an error/reauth screen instead of crashing. The `pause`/`continue` op names and the
> `status` enum in `focus-state.js` are best-effort and flagged for live confirmation
> (PLAN Phase 0).

## Development

- `make bump_patch` / `bump_minor` / `bump_major` — bump version in both
  `package.json` and `manifest.json`.
- Pushing a changed `manifest.json` to `main` triggers `.github/workflows/release.yml`,
  which builds the ZIP and creates a GitHub release.
