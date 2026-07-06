// Derives the logical button state (PLAN §6) from TickTick's `current` focus object,
// plus a local tick so MM:SS counts down between polls without hitting the API.
//
// The `current` shape (PLAN §5.1):
//   { id, type, status, valid, exited, duration(min), startTime, endTime,
//     pauseDuration(sec), focusBreak:{ duration(min), startTime }, ... }
//
// ⚠️ `status`/`type` enum values below are best-effort and marked for Phase-0
//    confirmation. They are isolated here so a capture can correct them in one spot.

export const State = Object.freeze({
  IDLE: 'IDLE',
  FOCUSING: 'FOCUSING',
  PAUSED: 'PAUSED',
  BREAK_PROMPT: 'BREAK_PROMPT',
  BREAK: 'BREAK',
  NO_TOKEN: 'NO_TOKEN',
  REAUTH: 'REAUTH',
  ERROR: 'ERROR',
});

// TickTick pomodoro session status (best-effort — confirm in Phase 0).
const STATUS_PAUSED = 1;

function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

function isPaused(current) {
  if (!current) return false;
  if (current.status === STATUS_PAUSED) return true;
  // Fallback signal: a "pauseTime" set with no matching resume.
  return current.pauseTime != null && !current.exited;
}

// Derive { state, remainingSec, endsAtMs, label } from `current` at time `now` (ms).
export function deriveState(current, now = Date.now()) {
  if (!current || current.exited || current.valid === false) {
    return { state: State.IDLE, remainingSec: 0 };
  }

  // Break in progress? focusBreak.startTime marks when the break began.
  const brk = current.focusBreak;
  const brkStart = toMs(brk?.startTime);
  if (brk && brkStart != null && brk.duration) {
    const brkEnds = brkStart + brk.duration * 60_000;
    if (now < brkEnds) {
      return {
        state: State.BREAK,
        remainingSec: Math.max(0, Math.round((brkEnds - now) / 1000)),
        endsAtMs: brkEnds,
      };
    }
    // Break elapsed → session is effectively finished.
    return { state: State.IDLE, remainingSec: 0 };
  }

  const endMs = toMs(current.endTime);
  const startMs = toMs(current.startTime);
  // endTime is the source of truth for the focus countdown. If absent, fall back
  // to startTime + duration.
  const focusEnds = endMs != null
    ? endMs
    : (startMs != null && current.duration ? startMs + current.duration * 60_000 : null);

  if (isPaused(current)) {
    // While paused the countdown is frozen. Prefer an explicit remaining if the
    // server provides one; otherwise freeze at endTime−now captured now.
    const remainingSec = focusEnds != null ? Math.max(0, Math.round((focusEnds - now) / 1000)) : 0;
    return { state: State.PAUSED, remainingSec, endsAtMs: focusEnds };
  }

  if (focusEnds != null && now >= focusEnds) {
    // Focus completed and no break yet → offer the break.
    return { state: State.BREAK_PROMPT, remainingSec: 0 };
  }

  if (focusEnds != null) {
    return {
      state: State.FOCUSING,
      remainingSec: Math.max(0, Math.round((focusEnds - now) / 1000)),
      endsAtMs: focusEnds,
    };
  }

  // Active session with no usable timing — treat as focusing with unknown time.
  return { state: State.FOCUSING, remainingSec: 0 };
}

// Recompute just the countdown for a live tick (FOCUSING/BREAK) without re-deriving
// the whole state. Returns the new remaining seconds, clamped at 0.
export function tickRemaining(derived, now = Date.now()) {
  if (!derived || derived.endsAtMs == null) return derived?.remainingSec ?? 0;
  return Math.max(0, Math.round((derived.endsAtMs - now) / 1000));
}

export function formatMMSS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
