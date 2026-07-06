// TickTick live-focus client — talks to the PRIVATE (unofficial) TickTick APIs.
//
// ⚠️  Everything host-specific lives in this file (PLAN §12). If TickTick changes
//     the shapes, this is the only place that should need edits.
//
// Auth model (PLAN §4): a session token — the value of the `t` cookie — is pasted
// by the user (the browser's email/password `signon` needs a browser-generated
// X-Csrftoken that a headless plugin can't reliably forge). Every call sends the
// token as `Cookie: t=<token>`.

import { randomBytes } from 'crypto';

const FOCUS_OP_URL = 'https://ms.ticktick.com/focus/batch/focusOp';
const PREFS_URL = 'https://api.ticktick.com/api/v2/user/preferences/pomodoro';

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const ErrorKind = Object.freeze({
  NO_TOKEN: 'NO_TOKEN',
  AUTH: 'AUTH',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
});

export class TickTickError extends Error {
  constructor(kind, message, data) {
    super(message || kind);
    this.name = 'TickTickError';
    this.kind = kind;
    this.data = data;
  }
}

// TickTick op ids are 24-char lowercase hex strings generated client-side (PLAN §5.1).
export function newId() {
  return randomBytes(12).toString('hex');
}

// ISO 8601 with a literal +0000 offset, matching what the webapp sends.
function tickTime(date = new Date()) {
  return date.toISOString().replace('Z', '+0000');
}

async function httpJson(url, { method = 'GET', token, body, signal, headers: extra, log } = {}) {
  if (log) log('http →', method, url, 'hasCookie=', !!token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (token) headers.Cookie = `t=${token}`;
  if (extra) Object.assign(headers, extra);

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    const msg = controller.signal.aborted ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (e?.message || 'fetch failed');
    throw new TickTickError(ErrorKind.NETWORK, msg);
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (log) {
    const code = data && typeof data === 'object' ? (data.errorCode || 'ok') : (typeof data === 'string' ? 'html/text' : 'ok');
    log('http ←', resp.status, url, 'errorCode=', code);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new TickTickError(ErrorKind.AUTH, `HTTP ${resp.status}`);
  }
  // TickTick sometimes returns 200 with an error code envelope for an expired session.
  if (data && typeof data === 'object' && data.errorCode === 'user_not_sign_on') {
    throw new TickTickError(ErrorKind.AUTH, 'user_not_sign_on');
  }
  if (!resp.ok) {
    // Only surface a short JSON error code — never an HTML error page body.
    const detail = data && typeof data === 'object' ? (data.errorCode || data.errorMessage) : null;
    throw new TickTickError(ErrorKind.UNKNOWN, `HTTP ${resp.status}${detail ? `: ${detail}` : ''}`,
      data && typeof data === 'object' ? data.data : null);
  }
  return data;
}

// --- Preferences -----------------------------------------------------------

const DEFAULT_PREFS = Object.freeze({
  pomoDuration: 25,
  shortBreakDuration: 5,
  longBreakDuration: 15,
  longBreakInterval: 4,
});

export async function getPomoPrefs(token, { signal } = {}) {
  if (!token) throw new TickTickError(ErrorKind.NO_TOKEN, 'no token');
  const data = await httpJson(PREFS_URL, { token, signal });
  return { ...DEFAULT_PREFS, ...(data && typeof data === 'object' ? data : {}) };
}

// --- Live focus state ------------------------------------------------------

// Read the current live focus session without mutating it (empty opList, PLAN §5.1).
// Returns { point, current } where `current` may be null/empty when idle.
export async function getState(token, { lastPoint = 0, signal } = {}) {
  if (!token) throw new TickTickError(ErrorKind.NO_TOKEN, 'no token');
  const data = await httpJson(FOCUS_OP_URL, {
    method: 'POST',
    token,
    body: { lastPoint, opList: [] },
    signal,
  });
  return normalizeStateResponse(data);
}

// Supported operations (PLAN §5.1). `pause`/`continue` op names are still pending
// live confirmation (Phase 0) — kept here so there is a single place to adjust them.
export const Op = Object.freeze({
  START: 'start',
  START_BREAK: 'startBreak',
  PAUSE: 'pause',
  CONTINUE: 'continue',
  EXIT: 'exit', // ⚠️ never used in v1 (PLAN §6)
});

// Build one op entry for the opList payload.
function buildOp({ op, duration = 0, sessionId, firstFocusId, pomoCount = 0, autoPomoLeft = 0, focusOnId = '' }) {
  return {
    id: newId(),
    oId: sessionId,
    oType: 0,
    op,
    duration,
    firstFocusId: firstFocusId || sessionId,
    focusOnId,
    autoPomoLeft,
    pomoCount,
    manual: true,
    note: '',
    time: tickTime(),
  };
}

// Send a single focus operation and return the reconciled { point, current }.
//
// For `start` a fresh session id is minted; for the others we operate on the
// session id carried in `current` (from the last getState).
export async function sendOp(token, { op, duration = 0, current, point = 0, signal } = {}) {
  if (!token) throw new TickTickError(ErrorKind.NO_TOKEN, 'no token');

  const isStart = op === Op.START;
  const sessionId = isStart ? newId() : (current?.id || newId());
  const entry = buildOp({
    op,
    duration,
    sessionId,
    firstFocusId: current?.firstFocusId || sessionId,
    pomoCount: current?.pomoCount ?? 0,
    autoPomoLeft: current?.autoPomoLeft ?? 0,
  });

  const data = await httpJson(FOCUS_OP_URL, {
    method: 'POST',
    token,
    body: { lastPoint: point, opList: [entry] },
    signal,
  });
  return normalizeStateResponse(data);
}

function normalizeStateResponse(data) {
  if (!data || typeof data !== 'object') return { point: 0, current: null };
  const current = data.current && typeof data.current === 'object' && Object.keys(data.current).length
    ? data.current
    : null;
  return { point: Number(data.point) || 0, current };
}
