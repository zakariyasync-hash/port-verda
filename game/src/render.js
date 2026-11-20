// render.js — everything Port Verda draws. All art is procedural: flat
// shapes, shading and a few strokes on the canvas, no image files.
// drawWorld paints the visible slice of the city (camera-centred), then
// the cars, pedestrians, player, police and the mission marker on top.
// drawMinimap paints a small live map in the corner of the screen.

import { CFG } from './config.js';

const C = CFG.COLORS;

// A small helper: fill a rect in world space, already translated by camera.
function rect(ctx, x, y, w, h) {
  ctx.fillRect(x, y, w, h);
}

function drawWater(ctx, city, vx, vy, vw, vh, t) {
  ctx.fillStyle = C.waterDeep;
  for (const w of city.water) {
    const x = Math.max(w.x, vx);
    const y = Math.max(w.y, vy);
    const rw = Math.min(w.x + w.w, vx + vw) - x;
    const rh = Math.min(w.y + w.h, vy + vh) - y;
    if (rw > 0 && rh > 0) rect(ctx, x, y, rw, rh);
  }
  // Gentle moving wave lines on the open sea.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const seaTop = CFG.HARBOR_WATER_TOP;
  for (let i = 0; i < 5; i++) {
    const wy = seaTop + 34 + i * 52 + Math.sin(t * 0.7 + i * 1.7) * 6;
    if (wy < vy || wy > vy + vh) continue;
    for (let x = vx; x < vx + vw; x += 90) {
      const yy = wy + Math.sin((x + t * 40 + i * 50) * 0.02) * 3;
      ctx.moveTo(x, yy);
      ctx.lineTo(x + 46, yy);
    }
  }
  ctx.stroke();
}

function drawRoads(ctx, city, vx, vy, vw, vh) {
  for (const r of city.roads) {
    if (r.dir === 'h') {
      if (r.y1 < vy - r.width || r.y1 > vy + vh + r.width) continue;
      ctx.fillStyle = C.road;
      rect(ctx, Math.max(r.x1, vx), r.y1 - r.width / 2, Math.min(r.x2, vx + vw) - Math.max(r.x1, vx), r.width);
      // Centre dashes.
      ctx.fillStyle = C.roadLine;
      const start = Math.max(r.x1, vx - 40);
      const end = Math.min(r.x2, vx + vw + 40);
      for (let x = start - (start % 56); x < end; x += 56) {
        rect(ctx, x, r.y1 - 1.5, 28, 3);
      }
    } else {
      if (r.x1 < vx - r.width || r.x1 > vx + vw + r.width) continue;
      ctx.fillStyle = C.road;
      rect(ctx, r.x1 - r.width / 2, Math.max(r.y1, vy), r.width, Math.min(r.y2, vy + vh) - Math.max(r.y1, vy));
      ctx.fillStyle = C.roadLine;
      const start = Math.max(r.y1, vy - 40);
      const end = Math.min(r.y2, vy + vh + 40);
      for (let y = start - (start % 56); y < end; y += 56) {
        rect(ctx, r.x1 - 1.5, y, 3, 28);
      }
    }
  }
}

function drawBuildings(ctx, city, vx, vy, vw, vh) {
  for (const b of city.buildings) {
    if (b.x > vx + vw || b.x + b.w < vx || b.y > vy + vh || b.y + b.h < vy) continue;
    // Drop shadow to the south-east, scaled by height.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const sh = 4 + b.tall * 2;
    rect(ctx, b.x + sh, b.y + sh, b.w, b.h);
    // Walls.
    ctx.fillStyle = C.buildingWall;
    rect(ctx, b.x, b.y, b.w, b.h);
    // Roof, shaded per building.
    ctx.fillStyle = C[b.roof] || C.buildingRoof;
    ctx.globalAlpha = Math.min(1, Math.max(0.7, b.shade));
    rect(ctx, b.x + 2, b.y + 2, b.w - 4, b.h - 4);
    ctx.globalAlpha = 1;
    // Roof details: a darker inset + a skylight block for tall slabs.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    rect(ctx, b.x + 6, b.y + 6, b.w - 12, b.h - 12);
    if (b.tall >= 3) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      rect(ctx, b.x + b.w * 0.28, b.y + b.h * 0.28, b.w * 0.44, b.h * 0.44);
    }
  }
}

function drawCarShape(ctx, x, y, angle, color, isPolice) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // Body: length along the facing axis.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-19, -9, 40, 20);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-20, -11, 40, 22, 6);
  ctx.fill();
  // Cabin + windshield.
  ctx.fillStyle = 'rgba(20,30,44,0.85)';
  ctx.beginPath();
  ctx.roundRect(-6, -8, 14, 16, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(180,220,255,0.55)';
  ctx.fillRect(6, -8, 4, 16);
  // Headlights.
  ctx.fillStyle = '#ffe9a3';
  ctx.fillRect(18, -9, 2, 4);
  ctx.fillRect(18, 5, 2, 4);
  if (isPolice) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-2, -11, 8, 3);
    ctx.fillRect(-2, 8, 8, 3);
  }
  ctx.restore();
}

function drawPersonShape(ctx, x, y, angle, shirt, pants) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(1, 2, 9, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  // Legs, body, head.
  ctx.fillStyle = pants;
  ctx.fillRect(-4, -6, 8, 5);
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8b98a';
  ctx.beginPath();
  ctx.arc(6, 0, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMissionMarker(ctx, x, y, t) {
  const bob = Math.sin(t * 3) * 5;
  ctx.save();
  ctx.translate(x, y + bob - 26);
  ctx.fillStyle = '#ffd23e';
  ctx.strokeStyle = '#7a5b00';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 12);
  ctx.lineTo(-11, -6);
  ctx.lineTo(-4, -6);
  ctx.lineTo(-4, -14);
  ctx.lineTo(4, -14);
  ctx.lineTo(4, -6);
  ctx.lineTo(11, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // Pulsing ring on the ground.
  ctx.strokeStyle = 'rgba(255,210,62,0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 18 + Math.sin(t * 3) * 4, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawWorld(ctx, cam, state, city) {
  // Viewport in CSS pixels: the canvas backing store may be larger on
  // high-density displays, but the transform maps drawing to CSS pixels.
  const vw = ctx.canvas.clientWidth || ctx.canvas.width;
  const vh = ctx.canvas.clientHeight || ctx.canvas.height;
  const vx = cam.x - vw / 2;
  const vy = cam.y - vh / 2;
  const t = state.time;

  ctx.save();
  ctx.translate(-vx, -vy);

  // Ground.
  ctx.fillStyle = C.ground;
  rect(ctx, vx, vy, vw, vh);
  // Dry patches for texture (deterministic checker of large soft squares).
  ctx.fillStyle = C.groundDry;
  const gs = 160;
  for (let gy = Math.floor(vy / gs) * gs; gy < vy + vh; gy += gs) {
    for (let gx = Math.floor(vx / gs) * gs; gx < vx + vw; gx += gs) {
      if (((gx / gs + gy / gs) % 2 + 2) % 2 === 0) rect(ctx, gx, gy, gs, gs);
    }
  }

  // Parks.
  for (const p of city.parks) {
    if (p.x > vx + vw || p.x + p.w < vx || p.y > vy + vh || p.y + p.h < vy) continue;
    ctx.fillStyle = C.park;
    rect(ctx, p.x, p.y, p.w, p.h);
    ctx.fillStyle = C.parkDark;
    // A few round trees.
    const n = Math.max(2, Math.floor((p.w * p.h) / 2600));
    for (let i = 0; i < n; i++) {
      const tx = p.x + ((i * 67) % Math.max(1, p.w - 24)) + 12;
      const ty = p.y + ((i * 41) % Math.max(1, p.h - 24)) + 12;
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Harbour concrete + wooden docks.
  ctx.fillStyle = C.harborConcrete;
  rect(ctx, vx, CFG.HARBOR_STRIP_TOP + 13, vw, CFG.HARBOR_WATER_TOP - CFG.HARBOR_STRIP_TOP - 13);
  ctx.fillStyle = C.dockWood;
  for (let i = 0; i < CFG.HARBOR_DOCKS; i++) {
    const dx = 240 + i * 500;
    if (dx < vx - 120 || dx > vx + vw) continue;
    rect(ctx, dx, CFG.HARBOR_WATER_TOP - 58, 110, 58);
  }
  // Stacked shipping containers along the quay, and two gantry cranes.
  const contColors = C.containers;
  for (let i = 0; i < 10; i++) {
    const cx = 120 + i * 300;
    if (cx < vx - 80 || cx > vx + vw) continue;
    const stack = (i % 3) + 1;
    for (let s = 0; s < stack; s++) {
      ctx.fillStyle = contColors[(i + s) % contColors.length];
      rect(ctx, cx, CFG.HARBOR_WATER_TOP - 34 - s * 18, 64, 15);
    }
  }
  ctx.strokeStyle = '#3a3f47';
  ctx.lineWidth = 5;
  for (const craneX of [560, 2260]) {
    if (craneX < vx - 120 || craneX > vx + vw) continue;
    const baseY = CFG.HARBOR_WATER_TOP - 10;
    ctx.beginPath();
    ctx.moveTo(craneX, baseY);
    ctx.lineTo(craneX, baseY - 150);
    ctx.lineTo(craneX + 110, baseY - 150);
    ctx.moveTo(craneX, baseY - 150);
    ctx.lineTo(craneX - 40, baseY - 110);
    ctx.stroke();
    ctx.fillStyle = '#c9502e';
    rect(ctx, craneX + 96, baseY - 150, 14, 26);
  }

  drawWater(ctx, city, vx, vy, vw, vh, t);
  drawRoads(ctx, city, vx, vy, vw, vh);
  drawBuildings(ctx, city, vx, vy, vw, vh);

  // Cars (traffic + parked + the player's car).
  for (const car of state.cars || []) {
    drawCarShape(ctx, car.x, car.y, car.angle || 0, car.color || '#c94f42', false);
  }
  // Police cars on top of traffic.
  for (const cop of state.police || []) {
    const car = cop.car || cop;
    drawCarShape(ctx, car.x, car.y, car.angle || 0, '#2f6fd0', true);
    // Flashing light bar.
    ctx.fillStyle = Math.floor(t * 6) % 2 === 0 ? '#ff3b30' : '#3b82ff';
    ctx.beginPath();
    ctx.arc(car.x, car.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pedestrians — anggota geng Harbor Kings (misi 5) berbaju merah gelap.
  const shirts = ['#d95f4b', '#4b8fd9', '#e0a83c', '#7fb069', '#9b7ede', '#e07a9b'];
  (state.peds || []).forEach((p, i) => {
    drawPersonShape(ctx, p.x, p.y, p.angle || 0, p.gang === true ? '#8e2f23' : shirts[i % shirts.length], '#2e3440');
  });
  // Player: on foot as a person, in a car as the car itself.
  const pl = state.player;
  if (pl) {
    if (pl.onFoot) {
      drawPersonShape(ctx, pl.x, pl.y, pl.angle || 0, '#f2c94c', '#23272f');
      // Cincin putih supaya pemain jalan kaki mudah ditemukan di tengah
      // kota (sama seperti cincin kuning saat mengemudi).
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, 15, 0, Math.PI * 2);
      ctx.stroke();
      // Direction tick.
      ctx.strokeStyle = '#f2c94c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pl.x, pl.y);
      ctx.lineTo(pl.x + Math.cos(pl.angle || 0) * 18, pl.y + Math.sin(pl.angle || 0) * 18);
      ctx.stroke();
    } else if (pl.carId != null) {
      const car = (state.cars || []).find((c) => c.id === pl.carId);
      if (car) {
        ctx.strokeStyle = '#ffd23e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(car.x, car.y, 26, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  // Peluru: garis kuning pendek searah gerak + percik di ujungnya.
  for (const b of state.bullets || []) {
    const speed = Math.hypot(b.vx || 0, b.vy || 0) || 1;
    const ux = (b.vx || 0) / speed;
    const uy = (b.vy || 0) / speed;
    ctx.strokeStyle = '#ffd23e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x - ux * 14, b.y - uy * 14);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Health pack (P3K): kotak putih dengan palang merah.
  for (const p of state.pickups || []) {
    if (p.kind !== 'health') continue;
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(p.x - 11, p.y - 11, 22, 22);
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x - 11, p.y - 11, 22, 22);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(p.x - 3, p.y - 8, 6, 16);
    ctx.fillRect(p.x - 8, p.y - 3, 16, 6);
  }
  // Mission marker.
  const spot = state.missions && state.missions.active && state.missions.active.target;
  if (spot) drawMissionMarker(ctx, spot.x, spot.y, t);

  ctx.restore();
}

export function drawMinimap(ctx, state, city) {
  const w = CFG.MINIMAP_W;
  const h = CFG.MINIMAP_H;
  const cw = ctx.canvas.clientWidth || ctx.canvas.width;
  const mx = cw - w - CFG.MINIMAP_MARGIN;
  const my = CFG.MINIMAP_MARGIN;
  const sx = w / CFG.WORLD_W;
  const sy = h / CFG.WORLD_H;

  ctx.save();
  // Panel.
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.beginPath();
  ctx.roundRect(mx - 5, my - 5, w + 10, h + 10, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Clip to the map rect.
  ctx.beginPath();
  ctx.rect(mx, my, w, h);
  ctx.clip();

  // Water + ground.
  ctx.fillStyle = '#274b34';
  ctx.fillRect(mx, my, w, h);
  for (const wa of city.water) {
    ctx.fillStyle = C.water;
    ctx.fillRect(mx + wa.x * sx, my + wa.y * sy, wa.w * sx, wa.h * sy);
  }
  // Roads.
  ctx.fillStyle = '#9aa0a8';
  for (const r of city.roads) {
    if (r.dir === 'h') ctx.fillRect(mx + r.x1 * sx, my + r.y1 * sy - 1, (r.x2 - r.x1) * sx, 2);
    else ctx.fillRect(mx + r.x1 * sx - 1, my + r.y1 * sy, 2, (r.y2 - r.y1) * sy);
  }
  // Buildings as faint blocks.
  ctx.fillStyle = 'rgba(20,22,28,0.55)';
  for (const b of city.buildings) {
    ctx.fillRect(mx + b.x * sx, my + b.y * sy, Math.max(1, b.w * sx), Math.max(1, b.h * sy));
  }

  const blip = (x, y, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(mx + x * sx, my + y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // Mission target.
  const spot = state.missions && state.missions.active && state.missions.active.target;
  if (spot) blip(spot.x, spot.y, 4, '#ffd23e');
  // Police.
  for (const cop of state.police || []) {
    const car = cop.car || cop;
    blip(car.x, car.y, 3, '#3b82ff');
  }
  // Player, with a white ring.
  const pl = state.player;
  if (pl) {
    blip(pl.x, pl.y, 4, '#ffffff');
    blip(pl.x, pl.y, 2.5, '#37d67a');
  }
  ctx.restore();
}
