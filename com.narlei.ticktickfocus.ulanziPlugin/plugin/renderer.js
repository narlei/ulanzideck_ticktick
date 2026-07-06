// SVG → dataURL renderer for the Focus button (PLAN §9).
// Helpers (svgDoc/toDataUrl/textWithShadow) mirror the Claude Usage plugin.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SIZE = 200;
const BG = '#1f1f23';
const TEXT = '#ffffff';
const SHADOW = 'rgba(0,0,0,0.85)';
const TRACK = '#33333b';

const FOCUS_GREEN = '#3ecf6b';
const BREAK_CYAN = '#22b8cf';
const PAUSE_AMBER = '#e3b341';
const MUTED = '#6a6a73';

const APP_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'action.png');
const APP_ICON_BASE64 = readFileSync(APP_ICON_PATH).toString('base64');

const RING_CX = SIZE / 2;
const RING_CY = 100;
const RING_R = 84;
const RING_W = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${body}</svg>`;
}

function toDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function textWithShadow(text, x, y, fontSize, weight = '700', anchor = 'middle', fill = TEXT) {
  const t = escapeXml(text);
  const font = '-apple-system,Helvetica,Arial,sans-serif';
  return (
    `<text x="${x + 1}" y="${y + 1}" font-family="${font}" font-size="${fontSize}" font-weight="${weight}" text-anchor="${anchor}" fill="${SHADOW}">${t}</text>` +
    `<text x="${x}" y="${y}" font-family="${font}" font-size="${fontSize}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${t}</text>`
  );
}

// The real TickTick app icon, embedded as a base64 PNG.
function tickIcon(cx, cy, size) {
  const half = size / 2;
  return `<image x="${cx - half}" y="${cy - half}" width="${size}" height="${size}" href="data:image/png;base64,${APP_ICON_BASE64}"/>`;
}

// Progress ring. `ratio` is the remaining fraction (1 = full, 0 = empty).
function ring(color, ratio) {
  const r = typeof ratio === 'number' ? Math.max(0, Math.min(1, ratio)) : 1;
  const dash = RING_CIRC * r;
  const gap = RING_CIRC - dash;
  return (
    `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${TRACK}" stroke-width="${RING_W}"/>` +
    `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="${RING_W}" ` +
    `stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" ` +
    `transform="rotate(-90 ${RING_CX} ${RING_CY})"/>`
  );
}

function frame(body) {
  return toDataUrl(svgDoc(`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BG}"/>${body}`));
}

// --- Timer screens (FOCUSING / PAUSED / BREAK) -----------------------------

function renderTimer({ mmss, ratio, color, caption, dimmed }) {
  // Timer sits above the ring centre; caption sits below it — both well inside the
  // enlarged ring so neither collides with the stroke.
  const body = [
    ring(color, ratio),
    textWithShadow(mmss, RING_CX, RING_CY - 4, 42, '700', 'middle', dimmed ? '#cfcfd6' : TEXT),
    caption ? textWithShadow(caption, RING_CX, RING_CY + 32, 22, '600', 'middle', color) : '',
  ].join('');
  return frame(body);
}

export function renderFocusing({ mmss, ratio }) {
  return renderTimer({ mmss, ratio, color: FOCUS_GREEN, caption: 'Focus' });
}

export function renderPaused({ mmss, ratio }) {
  return renderTimer({ mmss, ratio, color: PAUSE_AMBER, caption: '⏸ Paused', dimmed: true });
}

export function renderBreak({ mmss, ratio }) {
  return renderTimer({ mmss, ratio, color: BREAK_CYAN, caption: 'Break' });
}

// --- Prompt / idle ---------------------------------------------------------

export function renderIdle() {
  const body = [
    tickIcon(RING_CX, 84, 74),
    textWithShadow('Focus', RING_CX, 168, 34, '700'),
  ].join('');
  return frame(body);
}

export function renderBreakPrompt({ minutes = 5 } = {}) {
  const body = [
    `<circle cx="${RING_CX}" cy="90" r="52" fill="none" stroke="${BREAK_CYAN}" stroke-width="6"/>`,
    textWithShadow('☕', RING_CX, 108, 52, '400'),
    textWithShadow(`Relax ${minutes}'?`, RING_CX, 176, 30, '700', 'middle', BREAK_CYAN),
  ].join('');
  return frame(body);
}

// --- Neutral / status screens ----------------------------------------------

function renderNeutral({ icon, line1, line2, accent = MUTED }) {
  const body = [
    icon ? `<text x="${RING_CX}" y="96" font-size="64" text-anchor="middle" fill="${accent}">${escapeXml(icon)}</text>` : '',
    line1 ? textWithShadow(line1, RING_CX, 144, 28, '700') : '',
    line2 ? textWithShadow(line2, RING_CX, 176, 22, '600', 'middle', accent) : '',
  ].join('');
  return frame(body);
}

export function renderNoToken() {
  return renderNeutral({ icon: '\u{1F512}', line1: 'TickTick', line2: 'Add token' });
}

export function renderReauth() {
  return renderNeutral({ icon: '↻', line1: 'Token', line2: 'Re-paste', accent: PAUSE_AMBER });
}

export function renderLoading() {
  return renderNeutral({ icon: '…', line1: 'TickTick', line2: '' });
}

export function renderError({ msg } = {}) {
  return renderNeutral({ icon: '⚠', line1: 'Focus', line2: msg || 'error', accent: PAUSE_AMBER });
}
