## TickTick Focus v1.0.0

First release — a single smart **Focus** button for your Ulanzi Deck that controls and mirrors your TickTick focus/pomodoro timer.

- **Start** a focus session (default 25 min) with one click.
- **Pause / resume** an in-progress focus with the same click.
- When focus ends, the button offers **Relax 5'?** — click to start the break.
- **Mirrors** focus started or paused on another device (Mac, phone) within ~30 s.
- Shows the **live remaining time (MM:SS)** with a progress ring.

### Sign in with one click

Click **Sign in to TickTick** in the button settings — a small native window (macOS
WebKit, no Chromium, no download) opens the real TickTick login page. Log in however
you like (password, Google/Apple, captcha, 2FA); the session token is captured
automatically and saved. Nothing but the token is stored, and it persists across
restarts. If it ever expires, the button shows ↻ — just sign in again. A manual
paste-token fallback is available under *Advanced*.

### Install

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/narlei/ulanzideck-ticktick/main/install.sh)"
```
