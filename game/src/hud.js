// hud.js — Port Verda mission HUD layer + world markers (Builder B3).
//
// Written from scratch in this session. Canvas 2D only, no library, no assets.
// This module is the COMPLEMENT to render.js (B1), not a second HUD:
// render.js owns the base HUD (money/health/clock, wanted stars, top-centre
// mission banner, toast, speed, minimap) and the title/pause/busted/wasted
// screens. This module draws only what render.js does not have:
//
//   * the mission tracker panel (objective + live distance + courier timer /
//     guards-left / wanted readout) — placed right of the minimap so the two
//     never overlap;
//   * the ammo readout (bottom-right, above render.js's speed panel);
//   * the mission marker in the world: a pulsing diamond + label when the
//     target is on screen, an edge arrow + distance when it is off screen
//     (render.js draws only a beacon circle at the target, invisible off
//     screen).
//
// All drawing is in canvas pixel coordinates, like render.js (no 1280x720
// logical field). state.camera is the TOP-LEFT corner of the viewport, the
// same `cam` render.js drawWorld(ctx, cam, state) takes.
//
// Screens: drawTitle / drawPause / drawBusted / drawWasted delegate to
// render.js — single source of truth, same signatures — so main.js can call
// either module and get the same screen.

import { getActiveMission, getMinimapBlips, getMissionTarget, distanceToTarget, objectiveText } from './missions.js';
import { drawTitle as renderTitle, drawPaused as renderPaused, drawBusted as renderBusted, drawWasted as renderWasted } from './render.js';

const COLORS = {
  panel: 'rgba(10, 14, 20, 0.78)',
  panelBorder: 'rgba(255, 255, 255, 0.25)',
  text: '#eef1f5',
  muted: '#aab2c0',
  gold: '#ffd23f',
  green: '#4ade80',
  red: '#e63946',
};

function text(ctx, value, x, y, size, color, align = 'left', baseline = 'alphabetic', bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(value, x, y);
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/**
 * Format the clock. B1's contract (render.js): state.time is elapsed minutes
 * since 08:00, i.e. clock = 08:00 + state.time.
 */
export function formatClock(state) {
  const minutes = 480 + Math.floor((state && state.time) || 0);
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function missionTracker(ctx, state) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const active = getActiveMission(state);
  // Minimap (render.js) occupies x 8..224, y H-172..H-8: sit right of it.
  const x = 232;
  const y = H - 96;
  const w = Math.min(430, W - x - 16);
  if (w < 200) return;
  panel(ctx, x, y, w, 80);
  if (!active) {
    text(ctx, 'Tidak ada misi aktif', x + 12, y + 26, 17, COLORS.text, 'left', 'top');
    const done = state.missions && state.missions.done ? state.missions.done.length : 0;
    text(ctx, `Misi cerita selesai: ${done}/6`, x + 12, y + 52, 14, COLORS.muted, 'left', 'top');
    return;
  }
  const obj = objectiveText(state) || active.objective;
  text(ctx, active.title, x + 12, y + 24, 18, COLORS.gold, 'left', 'top', true);
  text(ctx, obj, x + 12, y + 50, 14, COLORS.text, 'left', 'top');
  const p = active.progress || {};
  if (active.id === 'courier' && typeof p.timeLeft === 'number') {
    text(ctx, `${Math.max(0, Math.ceil(p.timeLeft))} dtk`, x + w - 12, y + 24, 18, p.timeLeft < 15 ? COLORS.red : COLORS.text, 'right', 'top', true);
  }
  if (active.id === 'm3') {
    text(ctx, `Wanted: ${state.wanted ?? 0}`, x + w - 12, y + 24, 18, COLORS.red, 'right', 'top', true);
  }
}

function ammoReadout(ctx, state) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const pl = state.player || {};
  const ammo = state.ammo ?? pl.ammo ?? 30;
  // render.js speed panel sits at (W-132, H-64, 120x52) when driving.
  const y = pl.inCar ? H - 78 : H - 16;
  text(ctx, `Ammo ${ammo}`, W - 16, y, 16, COLORS.text, 'right', 'bottom');
}

/** World -> screen (canvas px). state.camera is the viewport's top-left. */
export function worldToScreen(state, x, y) {
  const cam = state.camera || {};
  const pl = state.player || {};
  // Back-compat: a centred camera is flagged explicitly by B1/main.js.
  if (state.cameraCentered) {
    const W = 1280;
    const H = 720;
    return { x: x - (cam.x ?? pl.x ?? 0) + W / 2, y: y - (cam.y ?? pl.y ?? 0) + H / 2 };
  }
  return { x: x - (cam.x ?? 0), y: y - (cam.y ?? 0) };
}

/**
 * Mission marker in the world + off-screen edge arrow. Call after
 * drawWorld, before the HUD panels. Police blips on the minimap come from
 * getMinimapBlips (B1 render.js draws them from state).
 */
export function drawMissionMarkers(ctx, state) {
  const target = getMissionTarget(state);
  if (!target) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const s = worldToScreen(state, target.x, target.y);
  const d = distanceToTarget(state);
  const onScreen = s.x >= 40 && s.x <= W - 40 && s.y >= 40 && s.y <= H - 40;
  ctx.save();
  if (onScreen) {
    const t = (state.timeSeconds ?? 0) * 2;
    const r = 12 + Math.sin(t) * 3;
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - r);
    ctx.lineTo(s.x + r, s.y);
    ctx.lineTo(s.x, s.y + r);
    ctx.lineTo(s.x - r, s.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    text(ctx, target.label, s.x, s.y - r - 10, 15, COLORS.gold, 'center', 'bottom', true);
    if (d !== null) text(ctx, `${Math.max(0, Math.round(d / 10))} m`, s.x, s.y + r + 18, 13, COLORS.text, 'center', 'top');
  } else {
    const cx = W / 2;
    const cy = H / 2;
    const angle = Math.atan2(s.y - cy, s.x - cx);
    const ex = cx + Math.cos(angle) * (W / 2 - 50);
    const ey = cy + Math.sin(angle) * (H / 2 - 50);
    ctx.translate(ex, ey);
    ctx.rotate(angle);
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-10, -12);
    ctx.lineTo(-10, 12);
    ctx.closePath();
    ctx.fill();
    ctx.rotate(-angle);
    const label = d !== null ? `${target.label} • ${Math.max(0, Math.round(d / 10))} m` : target.label;
    text(ctx, label, 0, -20, 14, COLORS.gold, 'center', 'bottom', true);
  }
  ctx.restore();
}

/** The B3 layer: mission tracker + ammo. Call after render.js drawHUD. */
export function drawPlayHud(ctx, state) {
  missionTracker(ctx, state);
  ammoReadout(ctx, state);
}

/**
 * One entry point: draws the B3 layer for the play screen. For other
 * screens the base screen is render.js's — drawHUD delegates to it so the
 * overlay is drawn exactly once, by the single source of truth.
 * opts: { screen: 'title'|'play'|'paused'|'busted'|'wasted'|'over',
 *         saveInfo: { hasSave, money, missionsDone } | null }
 */
export function drawHUD(ctx, state, opts = {}) {
  const screen = opts.screen || state.mode || 'play';
  ctx.save();
  if (screen === 'title') {
    const hasSave = !!(opts.saveInfo && opts.saveInfo.hasSave);
    renderTitle(ctx, state, hasSave);
  } else if (screen === 'paused') {
    drawPlayHud(ctx, state);
    renderPaused(ctx);
  } else if (screen === 'busted') {
    drawPlayHud(ctx, state);
    renderBusted(ctx);
  } else if (screen === 'wasted' || screen === 'over') {
    drawPlayHud(ctx, state);
    renderWasted(ctx);
  } else {
    drawPlayHud(ctx, state);
  }
  ctx.restore();
}

/** Screen overlays, delegated to render.js (single source of truth). */
export function drawTitle(ctx, state, saveInfo = null) {
  renderTitle(ctx, state, !!(saveInfo && saveInfo.hasSave));
}

export function drawPause(ctx) {
  renderPaused(ctx);
}

export function drawBusted(ctx) {
  renderBusted(ctx);
}

export function drawWasted(ctx) {
  renderWasted(ctx);
}

export { getMinimapBlips };
