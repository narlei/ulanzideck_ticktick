import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import os from 'os';
import UlanziApi from './plugin-common-node/index.js';
import {
  getState,
  sendOp,
  getPomoPrefs,
  Op,
  ErrorKind,
  TickTickError,
} from './ticktick-client.js';
import {
  deriveState,
  tickRemaining,
  formatMMSS,
  State,
} from './focus-state.js';
import {
  renderIdle,
  renderFocusing,
  renderPaused,
  renderBreak,
  renderBreakPrompt,
  renderNoToken,
  renderReauth,
  renderLoading,
  renderError,
} from './renderer.js';

const PLUGIN_UUID = 'com.narlei.ticktickfocus.plugin';
const POLL_INTERVAL_MS = 30_000; // PLAN §7 — server-authoritative poll
const TICK_INTERVAL_MS = 1_000; // local MM:SS countdown

const $UD = new UlanziApi();
const INSTANCES = new Map();

// Shared auth/config. Persisted to a file OUTSIDE the plugin dir so it survives
// both app restarts and `make install` (which rsync --deletes the plugin dir).
// The host's setGlobalSettings proved unreliable for this, so the file is the
// single source of truth.
const AUTH = { token: null, savedAt: 0, focusOverride: 0, breakOverride: 0, prefs: null };
const AUTH_DIR = join(os.homedir(), 'Library', 'Application Support', 'TickTickFocus');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

// Native WKWebView login helper bundled next to the plugin (resources/ticktick-login).
const LOGIN_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'ticktick-login');

// Silent by default. Set TTF_DEBUG=1 to get console output plus a debug.log next
// to app.js (useful when running `node plugin/app.js` by hand to diagnose).
const DEBUG = !!process.env.TTF_DEBUG;
const DEBUG_LOG = join(dirname(fileURLToPath(import.meta.url)), 'debug.log');

function log(...args) {
  if (!DEBUG) return;
  console.log('[ticktick-focus]', ...args);
  try {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* ignore log errors */ }
}

// Describe a secret (the token) without leaking it: length + first/last char.
function maskSecret(s) {
  if (s == null) return '(null)';
  if (s === '') return '(empty)';
  if (s.length <= 2) return `len=${s.length}`;
  return `len=${s.length} head=${s[0]} tail=${s[s.length - 1]}`;
}

// --- Durations -------------------------------------------------------------

function durations() {
  const p = AUTH.prefs || {};
  const focusMin = AUTH.focusOverride > 0 ? AUTH.focusOverride : (p.pomoDuration || 25);
  const breakMin = AUTH.breakOverride > 0 ? AUTH.breakOverride : (p.shortBreakDuration || 5);
  return { focusMin, breakMin };
}

// --- Rendering -------------------------------------------------------------

function pushIcon(context, dataUrl) {
  $UD.setBaseDataIcon(context, dataUrl);
}

function ratioFor(derived, totalSec) {
  if (!totalSec || derived.remainingSec == null) return 1;
  return derived.remainingSec / totalSec;
}

function renderForInstance(inst) {
  const d = inst.derived;
  if (!d) {
    pushIcon(inst.context, renderLoading());
    return;
  }
  const { focusMin, breakMin } = durations();
  switch (d.state) {
    case State.FOCUSING:
      pushIcon(inst.context, renderFocusing({
        mmss: formatMMSS(d.remainingSec),
        ratio: ratioFor(d, focusMin * 60),
      }));
      break;
    case State.PAUSED:
      pushIcon(inst.context, renderPaused({
        mmss: formatMMSS(d.remainingSec),
        ratio: ratioFor(d, focusMin * 60),
      }));
      break;
    case State.BREAK:
      pushIcon(inst.context, renderBreak({
        mmss: formatMMSS(d.remainingSec),
        ratio: ratioFor(d, breakMin * 60),
      }));
      break;
    case State.BREAK_PROMPT:
      pushIcon(inst.context, renderBreakPrompt({ minutes: breakMin }));
      break;
    case State.NO_TOKEN:
      pushIcon(inst.context, renderNoToken());
      break;
    case State.REAUTH:
      pushIcon(inst.context, renderReauth());
      break;
    case State.ERROR:
      pushIcon(inst.context, renderError({ msg: d.msg }));
      break;
    case State.IDLE:
    default:
      pushIcon(inst.context, renderIdle());
      break;
  }
}

// Map a thrown TickTickError to a logical error state.
function errorState(e) {
  if (e instanceof TickTickError) {
    if (e.kind === ErrorKind.NO_TOKEN) return { state: State.NO_TOKEN };
    if (e.kind === ErrorKind.AUTH) return { state: State.REAUTH };
    return { state: State.ERROR, msg: e.kind === ErrorKind.NETWORK ? 'offline' : 'error' };
  }
  return { state: State.ERROR, msg: 'error' };
}

function applyDerived(inst, derived) {
  inst.derived = derived;
  renderForInstance(inst);
  scheduleTick(inst);
}

// --- Server sync -----------------------------------------------------------

async function ensurePrefs() {
  if (!AUTH.token || AUTH.prefs) return;
  try {
    AUTH.prefs = await getPomoPrefs(AUTH.token);
  } catch (e) {
    log('prefs fetch failed', e?.message);
  }
}

async function refresh(inst, { force = false } = {}) {
  if (inst.inflight && !force) return;
  if (!AUTH.token) {
    applyDerived(inst, { state: State.NO_TOKEN });
    return;
  }
  inst.inflight = true;
  try {
    await ensurePrefs();
    const { point, current } = await getState(AUTH.token, { lastPoint: inst.point || 0 });
    inst.point = point;
    inst.current = current;
    applyDerived(inst, deriveState(current));
  } catch (e) {
    log('refresh failed', e?.message);
    applyDerived(inst, errorState(e));
  } finally {
    inst.inflight = false;
  }
}

function refreshAll(opts) {
  for (const inst of INSTANCES.values()) refresh(inst, opts);
}

// --- Click / operations ----------------------------------------------------

// Optimistic prediction so the button reacts instantly before the server confirms.
function optimistic(state, remainingSec, totalSec) {
  const endsAtMs = remainingSec != null ? Date.now() + remainingSec * 1000 : undefined;
  return { state, remainingSec: remainingSec ?? 0, endsAtMs, _total: totalSec };
}

async function handleClick(inst) {
  const d = inst.derived || { state: State.IDLE };
  const { focusMin, breakMin } = durations();

  if (!AUTH.token) {
    $UD.toast('Paste your TickTick token in the button settings.');
    applyDerived(inst, { state: State.NO_TOKEN });
    return;
  }

  let op = null;
  let duration = 0;
  let predicted = null;

  switch (d.state) {
    case State.IDLE:
      op = Op.START; duration = focusMin;
      predicted = optimistic(State.FOCUSING, focusMin * 60, focusMin * 60);
      break;
    case State.FOCUSING:
      op = Op.PAUSE;
      predicted = { state: State.PAUSED, remainingSec: d.remainingSec, endsAtMs: d.endsAtMs };
      break;
    case State.PAUSED:
      op = Op.CONTINUE;
      predicted = optimistic(State.FOCUSING, d.remainingSec, focusMin * 60);
      break;
    case State.BREAK_PROMPT:
      op = Op.START_BREAK; duration = breakMin;
      predicted = optimistic(State.BREAK, breakMin * 60, breakMin * 60);
      break;
    case State.BREAK:
      // Toggle pause/continue on the break, same as focus.
      op = Op.PAUSE;
      predicted = { state: State.BREAK, remainingSec: d.remainingSec, endsAtMs: d.endsAtMs };
      break;
    case State.REAUTH:
    case State.NO_TOKEN:
      $UD.toast('Paste your TickTick token in the button settings.');
      return;
    case State.ERROR:
    default:
      refresh(inst, { force: true });
      return;
  }

  // Optimistic UI, then send + reconcile with the server's reconciled `current`.
  applyDerived(inst, predicted);
  try {
    const { point, current } = await sendOp(AUTH.token, {
      op,
      duration,
      current: inst.current,
      point: inst.point || 0,
    });
    inst.point = point;
    inst.current = current;
    applyDerived(inst, deriveState(current));
  } catch (e) {
    log('op failed', op, e?.message);
    applyDerived(inst, errorState(e));
  }
}

// --- Local tick ------------------------------------------------------------

function scheduleTick(inst) {
  const d = inst.derived;
  const live = d && (d.state === State.FOCUSING || d.state === State.BREAK);
  if (!live || !inst.active) {
    stopTick(inst);
    return;
  }
  if (inst.tickTimer) return;
  inst.tickTimer = setInterval(() => tick(inst), TICK_INTERVAL_MS);
}

function tick(inst) {
  const d = inst.derived;
  if (!d || d.endsAtMs == null) return stopTick(inst);
  const remaining = tickRemaining(d, Date.now());
  if (remaining <= 0) {
    // Completed locally (PLAN §6) — flip immediately, then confirm with the server.
    stopTick(inst);
    if (d.state === State.FOCUSING) {
      applyDerived(inst, { state: State.BREAK_PROMPT, remainingSec: 0 });
    } else {
      applyDerived(inst, { state: State.IDLE, remainingSec: 0 });
    }
    refresh(inst, { force: true });
    return;
  }
  d.remainingSec = remaining;
  renderForInstance(inst);
}

function stopTick(inst) {
  if (inst.tickTimer) { clearInterval(inst.tickTimer); inst.tickTimer = null; }
}

// --- Polling ---------------------------------------------------------------

function startPolling(inst) {
  stopPolling(inst);
  const jitter = Math.floor(Math.random() * 5_000);
  inst.startTimer = setTimeout(() => {
    refresh(inst);
    inst.pollTimer = setInterval(() => refresh(inst), POLL_INTERVAL_MS);
  }, jitter);
}

function stopPolling(inst) {
  if (inst.startTimer) { clearTimeout(inst.startTimer); inst.startTimer = null; }
  if (inst.pollTimer) { clearInterval(inst.pollTimer); inst.pollTimer = null; }
}

// --- Instances -------------------------------------------------------------

function ensureInstance(context, settings) {
  let inst = INSTANCES.get(context);
  if (!inst) {
    inst = {
      context,
      settings: settings || {},
      current: null,
      point: 0,
      derived: null,
      inflight: false,
      active: true,
      pollTimer: null,
      startTimer: null,
      tickTimer: null,
    };
    INSTANCES.set(context, inst);
    renderForInstance(inst);
    startPolling(inst);
  } else if (settings) {
    inst.settings = settings;
  }
  return inst;
}

// --- Auth persistence (token/overrides on disk) ----------------------------

function loadAuth() {
  try {
    const j = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    AUTH.token = j.token || null;
    AUTH.savedAt = j.savedAt || 0;
    AUTH.focusOverride = Number(j.focusOverride) || 0;
    AUTH.breakOverride = Number(j.breakOverride) || 0;
    log('auth loaded from', AUTH_FILE, '→ token', maskSecret(AUTH.token), 'savedAt', AUTH.savedAt);
    return true;
  } catch (e) {
    log('auth load skipped:', e?.code || e?.message);
    return false;
  }
}

function persistAuth() {
  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify({
      token: AUTH.token || '',
      savedAt: AUTH.savedAt || 0,
      focusOverride: AUTH.focusOverride || 0,
      breakOverride: AUTH.breakOverride || 0,
    }, null, 2));
    log('auth saved to', AUTH_FILE, '→ token', maskSecret(AUTH.token));
  } catch (e) {
    log('auth save FAILED:', e?.message);
  }
  // Best-effort mirror to the host too (harmless if unsupported).
  try { $UD.setGlobalSettings({ token: AUTH.token || '', savedAt: AUTH.savedAt || 0 }); } catch { /* noop */ }
}

// Reply to the property inspector with the current connection status.
function reportStatus(context) {
  $UD.sendToPropertyInspector({
    type: 'status',
    connected: !!AUTH.token,
    savedAt: AUTH.savedAt || 0,
    focusOverride: AUTH.focusOverride || 0,
    breakOverride: AUTH.breakOverride || 0,
  }, context);
}

// Open the native WKWebView login window; on success save the captured `t` cookie.
function runLogin(context) {
  let child;
  try {
    log('login: spawning', LOGIN_BIN);
    child = spawn(LOGIN_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log('login spawn failed:', e?.message);
    $UD.sendToPropertyInspector({ type: 'loginResult', ok: false, error: 'Could not open the login window' }, context);
    return;
  }
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.on('error', (e) => {
    log('login process error:', e?.message);
    $UD.sendToPropertyInspector({ type: 'loginResult', ok: false, error: e?.message || 'login failed' }, context);
  });
  child.on('close', (code) => {
    const token = out.trim();
    log('login closed: code', code, 'token', maskSecret(token));
    if (code === 0 && token) {
      AUTH.token = token;
      AUTH.savedAt = Date.now();
      AUTH.prefs = null;
      persistAuth();
      $UD.sendToPropertyInspector({ type: 'loginResult', ok: true }, context);
      reportStatus(context);
      refreshAll({ force: true });
    } else {
      const reason = code === 2 ? 'Login window closed' : (code === 3 ? 'Login timed out' : 'No token captured');
      $UD.sendToPropertyInspector({ type: 'loginResult', ok: false, error: reason }, context);
    }
  });
}

async function handlePluginMessage(msg) {
  const p = msg?.payload || {};
  const context = msg?.context;
  log('PI→plugin message: type=', p.type, 'payloadKeys=', Object.keys(p));
  switch (p.type) {
    case 'login':
      runLogin(context);
      break;
    case 'setToken': {
      AUTH.token = (p.token || '').trim() || null;
      AUTH.savedAt = AUTH.token ? Date.now() : 0;
      AUTH.prefs = null;
      log('setToken:', maskSecret(AUTH.token));
      persistAuth();
      reportStatus(context);
      refreshAll({ force: true });
      break;
    }
    case 'logout': {
      AUTH.token = null;
      AUTH.savedAt = 0;
      AUTH.prefs = null;
      persistAuth();
      reportStatus(context);
      refreshAll({ force: true });
      break;
    }
    case 'setDurations': {
      AUTH.focusOverride = Number(p.focusOverride) || 0;
      AUTH.breakOverride = Number(p.breakOverride) || 0;
      persistAuth();
      reportStatus(context);
      refreshAll();
      break;
    }
    case 'getStatus':
    default:
      reportStatus(context);
      break;
  }
}

// --- Wire up ---------------------------------------------------------------

// Load the saved token from disk BEFORE connecting, so any instance created on
// `add` already has auth and renders the real state instead of the login screen.
loadAuth();

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => {
  log('connected; token', maskSecret(AUTH.token));
  // Re-assert the token-derived state across any already-registered instances.
  refreshAll({ force: true });
});

$UD.onAdd((msg) => {
  log('add', msg.context);
  ensureInstance(msg.context, msg.param || {});
});

$UD.onParamFromApp((msg) => {
  const inst = ensureInstance(msg.context, msg.param || {});
  renderForInstance(inst);
});

$UD.onRun((msg) => {
  const inst = ensureInstance(msg.context, msg.param || {});
  log('click', msg.context, inst.derived?.state);
  handleClick(inst);
});

$UD.onSetActive((msg) => {
  const inst = INSTANCES.get(msg.context);
  if (!inst) return;
  inst.active = !!msg.active;
  if (inst.active) {
    renderForInstance(inst);
    if (!inst.pollTimer && !inst.startTimer) startPolling(inst);
    scheduleTick(inst);
  } else {
    stopPolling(inst);
    stopTick(inst);
  }
});

$UD.onSendToPlugin((msg) => handlePluginMessage(msg));

$UD.onClear((msg) => {
  if (!msg.param) return;
  for (const item of msg.param) {
    const inst = INSTANCES.get(item.context);
    if (inst) {
      stopPolling(inst);
      stopTick(inst);
      INSTANCES.delete(item.context);
      log('clear', item.context);
    }
  }
});

$UD.onError((err) => log('socket error', err));
$UD.onClose(() => log('socket closed'));
