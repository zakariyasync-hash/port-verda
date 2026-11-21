// render.js — all drawing for Port Verda, canvas 2D, procedural art only.
// The static city (ground, roads, buildings, water, piers, ships) is
// painted once into an offscreen canvas and blitted each frame; only
// cars, people, effects and the HUD are drawn per frame.
import { CFG } from './config.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

let staticCache = null; // { seed, canvas }

function buildStaticLayer(city) {
  const layer = document.createElement('canvas');
  layer.width = CFG.WORLD_W;
  layer.height = CFG.WORLD_H;
  const g = layer.getContext('2d');

  // District ground tints.
  for (const d of city.districts) {
    g.fillStyle = CFG.DISTRICTS[d.key].ground;
    g.fillRect(d.x, d.y, d.w, d.h);
  }

  // Harbour water with depth gradient and baked wave strokes.
  const grad = g.createLinearGradient(0, CFG.WATER_Y, 0, CFG.WORLD_H);
  grad.addColorStop(0, CFG.WATER_COLOR);
  grad.addColorStop(1, CFG.WATER_DEEP);
  g.fillStyle = grad;
  g.fillRect(0, CFG.WATER_Y, CFG.WORLD_W, CFG.WORLD_H - CFG.WATER_Y);
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 2;
  for (let y = CFG.WATER_Y + 18; y < CFG.WORLD_H - 8; y += 26) {
    g.beginPath();
    for (let x = 0; x <= CFG.WORLD_W; x += 64) {
      const yy = y + Math.sin(x / 90 + y) * 3;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }

  // Parks: grass, darker border, trees.
  for (const p of city.parks) {
    g.fillStyle = CFG.PARK_COLOR;
    g.fillRect(p.x, p.y, p.w, p.h);
    g.strokeStyle = CFG.PARK_DARK;
    g.lineWidth = 4;
    g.strokeRect(p.x + 2, p.y + 2, p.w - 4, p.h - 4);
    for (const t of p.trees) {
      g.fillStyle = CFG.PARK_DARK;
      g.beginPath();
      g.arc(t.x, t.y, t.r + 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#5da85a';
      g.beginPath();
      g.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Sidewalks: a pale band under every road.
  g.fillStyle = CFG.SIDEWALK_COLOR;
  for (const r of city.roads) {
    const w = CFG.ROAD_W + CFG.SIDEWALK * 2;
    if (r.vertical) g.fillRect(r.x1 - w / 2, r.y1, w, r.y2 - r.y1);
    else g.fillRect(r.x1, r.y1 - w / 2, r.x2 - r.x1, w);
  }

  // Asphalt.
  g.fillStyle = CFG.ROAD_COLOR;
  for (const r of city.roads) {
    if (r.vertical) g.fillRect(r.x1 - CFG.ROAD_W / 2, r.y1, CFG.ROAD_W, r.y2 - r.y1);
    else g.fillRect(r.x1, r.y1 - CFG.ROAD_W / 2, r.x2 - r.x1, CFG.ROAD_W);
  }

  // Lane markings: dashed centre line on every road.
  g.strokeStyle = '#d8c95a';
  g.lineWidth = 3;
  g.setLineDash([18, 22]);
  for (const r of city.roads) {
    g.beginPath();
    g.moveTo(r.x1, r.y1);
    g.lineTo(r.x2, r.y2);
    g.stroke();
  }
  g.setLineDash([]);

  // Quay containers on the strip between harbour-front street and promenade.
  for (const c of city.containers) {
    g.fillStyle = c.color;
    g.fillRect(c.x, c.y, c.w, c.h);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    g.strokeRect(c.x, c.y, c.w, c.h);
  }

  // Buildings: drop shadow, body, roof inset, district accent edge.
  for (const b of city.buildings) {
    const lift = b.height * 5;
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(b.x + lift, b.y + lift, b.w, b.h);
    g.fillStyle = b.color;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(b.x + 4, b.y + 4, b.w - 8, Math.max(6, b.h * 0.22));
    g.strokeStyle = b.accent;
    g.lineWidth = 2;
    g.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    if (b.height >= 3) {
      // Rooftop plant on tall downtown towers.
      g.fillStyle = b.accent;
      g.fillRect(b.x + b.w / 2 - 6, b.y + b.h / 2 - 6, 12, 12);
    }
  }

  // Piers and moored ships.
  g.fillStyle = '#8a6f4d';
  for (const p of city.piers) {
    g.fillRect(p.x, p.y, p.w, p.h);
    g.strokeStyle = '#5f4c33';
    g.lineWidth = 2;
    g.strokeRect(p.x, p.y, p.w, p.h);
  }
  for (const s of city.ships) {
    g.save();
    g.translate(s.x + s.w / 2, s.y + s.h / 2);
    g.rotate(s.angle);
    g.fillStyle = '#2c3844';
    g.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
    g.fillStyle = '#b3543f';
    g.fillRect(-s.w / 2 + 12, -s.h / 2 + 6, 44, s.h - 12);
    g.fillStyle = '#3f7ab5';
    g.fillRect(-s.w / 2 + 64, -s.h / 2 + 6, 44, s.h - 12);
    g.fillStyle = '#c98f3d';
    g.fillRect(-s.w / 2 + 116, -s.h / 2 + 6, 44, s.h - 12);
    g.fillStyle = '#e8e4d8';
    g.fillRect(s.w / 2 - 26, -s.h / 2 + 4, 18, s.h - 8);
    g.restore();
  }

  // Harbour cranes on the quay.
  for (const c of city.cranes) {
    g.strokeStyle = '#d8a13a';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(c.x, c.y + 34);
    g.lineTo(c.x, c.y - 52);
    g.lineTo(c.x + 58, c.y - 30);
    g.moveTo(c.x, c.y - 52);
    g.lineTo(c.x - 26, c.y - 30);
    g.stroke();
    g.fillStyle = '#8a6420';
    g.fillRect(c.x - 10, c.y + 30, 20, 8);
  }

  // District name labels, painted faintly over the ground.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const d of city.districts) {
    const pal = CFG.DISTRICTS[d.key];
    g.fillStyle = 'rgba(255,255,255,0.20)';
    g.font = `bold ${d.key === 'downtown' ? 64 : 52}px ${FONT}`;
    g.fillText(pal.label, d.x + d.w / 2, d.y + d.h / 2);
  }

  // Street lamps at every intersection.
  g.fillStyle = '#ffe9a8';
  for (const n of city.roadGraph.nodes) {
    g.beginPath();
    g.arc(n.x + CFG.ROAD_W / 2 + 6, n.y - CFG.ROAD_W / 2 - 6, 3, 0, Math.PI * 2);
    g.fill();
  }

  return layer;
}

function staticLayer(city) {
  if (!staticCache || staticCache.seed !== city.seed) {
    staticCache = { seed: city.seed, canvas: buildStaticLayer(city) };
  }
  return staticCache.canvas;
}

// --- dynamic entities ------------------------------------------------------

function drawCar(g, car, time) {
  g.save();
  g.translate(car.x, car.y);
  g.rotate(car.angle);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(-CFG.CAR_W / 2 + 3, -CFG.CAR_H / 2 + 4, CFG.CAR_W, CFG.CAR_H);
  g.fillStyle = car.color;
  g.beginPath();
  g.roundRect(-CFG.CAR_W / 2, -CFG.CAR_H / 2, CFG.CAR_W, CFG.CAR_H, 7);
  g.fill();
  g.fillStyle = '#1c2733';
  g.beginPath();
  g.roundRect(-8, -CFG.CAR_H / 2 + 4, 16, CFG.CAR_H - 8, 3);
  g.fill();
  g.fillStyle = '#cfe6ff';
  g.fillRect(CFG.CAR_W / 2 - 6, -CFG.CAR_H / 2 + 3, 3, 5);
  g.fillRect(CFG.CAR_W / 2 - 6, CFG.CAR_H / 2 - 8, 3, 5);
  if (car.isPolice) {
    const on = Math.floor(time * 6) % 2 === 0;
    g.fillStyle = on ? '#ff3b30' : '#2f7bff';
    g.fillRect(-6, -CFG.CAR_H / 2 - 2, 12, 5);
    g.fillStyle = on ? '#2f7bff' : '#ff3b30';
    g.fillRect(-6, CFG.CAR_H / 2 - 3, 12, 5);
  }
  g.restore();
}

function drawPed(g, ped) {
  if (ped.down) {
    g.fillStyle = '#5a4630';
    g.beginPath();
    g.ellipse(ped.x, ped.y, 13, 7, ped.angle, 0, Math.PI * 2);
    g.fill();
    return;
  }
  g.fillStyle = ped.color || '#e8dcc0';
  g.beginPath();
  g.arc(ped.x, ped.y, CFG.PED_RADIUS, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#222';
  g.beginPath();
  g.arc(ped.x + Math.cos(ped.angle) * 5, ped.y + Math.sin(ped.angle) * 5, 3.5, 0, Math.PI * 2);
  g.fill();
}

function drawPlayer(g, player, time) {
  if (player.inCar) return; // the car itself is drawn from state.cars
  const blink = player.invulnerable > 0 && Math.floor(time * 10) % 2 === 0;
  if (blink) return;
  g.save();
  g.translate(player.x, player.y);
  g.rotate(player.angle);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.arc(2, 3, CFG.PLAYER_RADIUS, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e8543f'; // Raka's courier jacket
  g.beginPath();
  g.arc(0, 0, CFG.PLAYER_RADIUS, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffd23f';
  g.fillRect(2, -4, 12, 8); // facing tick
  g.fillStyle = '#222';
  g.beginPath();
  g.arc(4, 0, 4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// --- main world pass -------------------------------------------------------

export function drawWorld(ctx, cam, state) {
  const city = state.city;
  const viewW = ctx.canvas.width;
  const viewH = ctx.canvas.height;
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, viewW, viewH);
  const layer = staticLayer(city);
  const sx = Math.max(0, Math.floor(cam.x));
  const sy = Math.max(0, Math.floor(cam.y));
  const sw = Math.min(CFG.WORLD_W - sx, viewW);
  const sh = Math.min(CFG.WORLD_H - sy, viewH);
  ctx.drawImage(layer, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  // Mission target beacon.
  const target = state.missions.target;
  if (target && state.missions.activeId) {
    const pulse = 1 + Math.sin(state.time * 5) * 0.12;
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(target.x, target.y, 26 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.moveTo(target.x, target.y - 34 * pulse);
    ctx.lineTo(target.x + 10, target.y - 14);
    ctx.lineTo(target.x - 10, target.y - 14);
    ctx.closePath();
    ctx.fill();
  }

  for (const car of state.cars) drawCar(ctx, car, state.time);
  for (const car of state.traffic) drawCar(ctx, car, state.time);
  for (const car of state.police) drawCar(ctx, car, state.time);
  for (const ped of state.peds) drawPed(ctx, ped);
  drawPlayer(ctx, state.player, state.time);

  // Transient effects: shot tracers and punch arcs.
  for (const fx of state.fx) {
    const a = Math.max(0, fx.ttl / fx.max);
    if (fx.kind === 'tracer') {
      ctx.strokeStyle = `rgba(255,220,90,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fx.x1, fx.y1);
      ctx.lineTo(fx.x2, fx.y2);
      ctx.stroke();
    } else if (fx.kind === 'punch') {
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, 18 * (1 - a) + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// --- minimap ---------------------------------------------------------------

export function drawMinimap(ctx, state) {
  const w = CFG.MINIMAP_W;
  const h = CFG.MINIMAP_H;
  const x0 = 12;
  const y0 = ctx.canvas.height - h - 12;
  const sx = w / CFG.WORLD_W;
  const sy = h / CFG.WORLD_H;

  ctx.save();
  ctx.fillStyle = 'rgba(10,14,20,0.82)';
  ctx.fillRect(x0 - 4, y0 - 4, w + 8, h + 8);
  ctx.strokeStyle = '#ffd23f';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 - 4, y0 - 4, w + 8, h + 8);
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();

  ctx.fillStyle = '#20262e';
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = CFG.WATER_COLOR;
  ctx.fillRect(x0, y0 + CFG.WATER_Y * sy, w, h - CFG.WATER_Y * sy);
  ctx.strokeStyle = '#7d838a';
  ctx.lineWidth = 1.5;
  for (const r of state.city.roads) {
    ctx.beginPath();
    ctx.moveTo(x0 + r.x1 * sx, y0 + r.y1 * sy);
    ctx.lineTo(x0 + r.x2 * sx, y0 + r.y2 * sy);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  for (const b of state.city.buildings) {
    ctx.fillRect(x0 + b.x * sx, y0 + b.y * sy, Math.max(1, b.w * sx), Math.max(1, b.h * sy));
  }

  const blip = (x, y, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x0 + x * sx, y0 + y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const target = state.missions.target;
  if (target && state.missions.activeId) blip(target.x, target.y, '#ffd23f', 5);
  for (const car of state.police) blip(car.x, car.y, Math.floor(state.time * 4) % 2 ? '#ff3b30' : '#2f7bff', 3.5);
  for (const car of state.traffic) blip(car.x, car.y, '#9aa0a3', 2);
  blip(state.player.x, state.player.y, '#ffffff', 4);
  ctx.strokeStyle = '#e8543f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x0 + state.player.x * sx, y0 + state.player.y * sy, 6.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// --- HUD and screens ---------------------------------------------------------

function text(ctx, value, x, y, size, color, align = 'left', bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y);
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

function clockString(totalMinutes) {
  const minutes = Math.floor(totalMinutes) % (24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function drawHUD(ctx, state) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  // Top-left: money, health, clock.
  panel(ctx, 12, 12, 230, 92);
  text(ctx, `$ ${state.money.toLocaleString('en-US')}`, 24, 44, 26, '#ffd23f', 'left', true);
  text(ctx, clockString((state.time / CFG.DAY_LENGTH_SECONDS) * 1440 + 8 * 60), 24, 72, 16, '#eef1f5');
  const bw = 196;
  const bh = 12;
  ctx.fillStyle = '#3a2020';
  ctx.fillRect(24, 82, bw, bh);
  ctx.fillStyle = state.health > 30 ? '#58c96b' : '#e5534b';
  ctx.fillRect(24, 82, (bw * Math.max(0, state.health)) / CFG.PLAYER_MAX_HEALTH, bh);
  text(ctx, `HP ${Math.ceil(state.health)}`, 228, 94, 12, '#eef1f5', 'right');

  // Top-right: wanted stars.
  panel(ctx, W - 192, 12, 180, 46);
  text(ctx, 'WANTED', W - 180, 32, 13, '#8b93a3', 'left', true);
  for (let i = 0; i < CFG.WANTED_MAX; i++) {
    text(ctx, '★', W - 118 + i * 22, 40, 22, i < state.wanted ? '#ffd23f' : '#4a4f55', 'left', true);
  }

  // Top-centre: active mission.
  const m = state.missions.active;
  if (m) {
    const label = `${m.name} — ${m.objective}`;
    ctx.font = `bold 17px ${FONT}`;
    const tw = ctx.measureText(label).width + 28;
    panel(ctx, (W - tw) / 2, 12, tw, 40);
    text(ctx, label, W / 2, 39, 17, '#ffd23f', 'center', true);
  }

  // Toast message under the mission line, width capped so it never
  // covers the money panel (left) or the wanted panel (right).
  if (state.toast && state.toast.ttl > 0) {
    ctx.font = `16px ${FONT}`;
    const maxW = Math.max(200, W - 480);
    let label = state.toast.text;
    if (ctx.measureText(label).width + 24 > maxW) {
      while (label.length > 0 && ctx.measureText(`${label}…`).width + 24 > maxW) label = label.slice(0, -1);
      label += '…';
    }
    const tw = ctx.measureText(label).width + 24;
    panel(ctx, (W - tw) / 2, 60, tw, 34);
    text(ctx, label, W / 2, 83, 16, '#eef1f5', 'center');
  }

  // Bottom-right: speed when driving.
  if (state.player.inCar) {
    const car = state.cars.find((c) => c.id === state.player.carId);
    const kmh = car ? Math.round(Math.abs(car.speed) * 0.36) : 0;
    panel(ctx, W - 132, H - 64, 120, 52);
    text(ctx, `${kmh}`, W - 72, H - 26, 30, '#eef1f5', 'center', true);
    text(ctx, 'km/h', W - 72, H - 12, 11, '#8b93a3', 'center');
  }

  // Bottom-centre hint.
  text(ctx, 'WASD gerak/nyetir · E masuk/keluar mobil · F pukul · Klik tembak · Shift boost · P jeda · M suara', W / 2, H - 8, 12, 'rgba(238,241,245,0.75)', 'center');

  drawMinimap(ctx, state);
}

function overlay(ctx, title, lines, prompt) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.fillStyle = 'rgba(8,12,18,0.72)';
  ctx.fillRect(0, 0, W, H);
  const w = 620;
  const h = 130 + lines.length * 30 + 70;
  const x = (W - w) / 2;
  const y = (H - h) / 2;
  panel(ctx, x, y, w, h);
  text(ctx, title, W / 2, y + 62, 44, '#ffd23f', 'center', true);
  lines.forEach((line, i) => text(ctx, line, W / 2, y + 108 + i * 30, 18, '#eef1f5', 'center'));
  text(ctx, prompt, W / 2, y + h - 28, 18, '#ffd23f', 'center', true);
}

export function drawTitle(ctx, state, hasSave) {
  overlay(
    ctx,
    'PORT VERDA',
    [
      'Kota pelabuhan fiktif. Kamu Raka, kurir pelabuhan.',
      'Mira punya kerjaan buatmu — dan Harbor Kings mengincarmu.',
      'Jelajahi kota, curi mobil, kabur dari polisi, selesaikan 6 misi.',
      hasSave ? 'Save tersimpan: tekan L untuk lanjutkan.' : '',
    ].filter(Boolean),
    'ENTER mulai baru' + (hasSave ? ' · L lanjutkan' : ''),
  );
}

export function drawPaused(ctx) {
  overlay(ctx, 'JEDA', ['Permainan disimpan.', 'P — lanjutkan · R — mulai ulang'], 'Tekan P untuk lanjut');
}

export function drawBusted(ctx) {
  overlay(ctx, 'TERTANGKAP', ['Polisi Verda menangkapmu.', 'Denda dibayar. Misi aktif dibatalkan.'], 'ENTER — coba lagi');
}

export function drawWasted(ctx) {
  overlay(ctx, 'RAKA TUMBANG', ['Kamu kehabisan tenaga di jalanan Port Verda.', 'Mira akan menagihmu nanti.'], 'ENTER — coba lagi');
}
