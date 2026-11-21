// vehicles.js — Port Verda (Builder B2: Vehicles & Life).
//
// Player car physics, traffic AI, parked cars, enter / exit / steal.
// Written from scratch in this session. Vanilla ES module, no library,
// no network, no external asset. Pure logic over the shared `state` object.
//
// STATE CONTRACT (agreed with B1 main.js / B3 missions.js):
//   state = { mode, time, money, health, wanted, wantedTimer,
//             player: { x, y, angle, speed, onFoot, inCar, carId, invulnerable },
//             cars: [], traffic: [], peds: [], police: [],
//             missions: { activeId, active, target, done: [], progress: {} },
//             camera: { x, y }, input, muted, fx: [], toast, city }
//   state.mode is 'title' | 'playing' | 'paused' | 'busted' | 'wasted'.
//   A car is { id, x, y, angle, speed, color, model,
//              isPlayer, isPolice, parked? }.
//   A traffic car additionally carries { nodeFrom, nodeTo, cruise,
//   waitTimer, stuckTimer, lane, abandoned } and lives in state.traffic
//   (render.js draws state.traffic separately from state.cars).
//   Parked and mission cars live in state.cars. A stolen traffic car is
//   MOVED from state.traffic into state.cars, because main.js's player
//   driver and the speedometer both look the player car up in state.cars.
//
// WIRING (main.js B1): step 2 calls updateVehicles(state, dt, input)
// every step while playing. main.js's own fallbackPlayer owns locomotion
// (on foot and the player car) until player.js lands, so updateVehicles
// deliberately does NOT drive the car again — it tops up parked cars,
// handles stealing a traffic car on E, and resolves car/car and
// car/pedestrian collisions once per step. updatePlayerCar is the full
// standalone driving model (for player.js and for tests): drive +
// collisions in one call, guarded by a per-step stamp so the collision
// pass never runs twice in one step even if both entry points run.
// updateTraffic / spawnTraffic live here by the B2 brief; traffic.js is a
// thin re-export adapter so main.js's step-3 traffic call runs this AI
// instead of its simpler fallback.
//
// CITY (B1 city.js): world 2560x1920, avenues x in CFG.AVENUES, streets
// y in CFG.STREETS plus the promenade at y=1680, water at y>=1740
// (piers exempt). Roads are 64 px wide with a 14 px sidewalk each side.
// The road graph has one node per intersection and no dead ends.

import { CFG } from './config.js';
import { buildCity, clampToWorld, collidesBuilding, isRoad, isWater, nearestRoad } from './city.js';
import { createRng } from './rng.js';
import { addWanted, witnessed } from './police.js';

const rng = createRng(CFG.SEED + 202);

// --- car models: original Port Verda lineup (no real-world badges) --------
export const CAR_MODELS = {
  sedan: { length: 46, width: 24, maxSpeed: 380, accel: 430, turn: 2.7 },
  taxi: { length: 46, width: 24, maxSpeed: 360, accel: 430, turn: 2.8 },
  truck: { length: 58, width: 26, maxSpeed: 280, accel: 320, turn: 2.0 },
  van: { length: 52, width: 26, maxSpeed: 320, accel: 360, turn: 2.3 },
  sport: { length: 44, width: 24, maxSpeed: 470, accel: 520, turn: 3.1 },
  police: { length: 46, width: 24, maxSpeed: 470, accel: 460, turn: 2.9 },
};

// main.js's parked-car names map onto the specs above.
const MODEL_ALIASES = {
  sedan: 'sedan', hatch: 'sedan', coupe: 'sport', sport: 'sport',
  pickup: 'truck', truck: 'truck', van: 'van', taxi: 'taxi',
  patrol: 'police', police: 'police',
};

export const MODEL_COLORS = {
  sedan: ['#c0392b', '#2e86c1', '#7d3c98', '#16a085', '#95a5a6'],
  taxi: ['#f1c40f'],
  truck: ['#3a6ea5', '#6b7c5e', '#8a5a3b'],
  van: ['#e67e22', '#95a5a6', '#2c3e50'],
  sport: ['#e63946', '#f1c40f', '#e8e8e8'],
  police: ['#20242a'],
};

export function modelSpec(model) {
  const key = MODEL_ALIASES[String(model || 'sedan').toLowerCase()] || 'sedan';
  return CAR_MODELS[key];
}

function pickColor(model) {
  const key = MODEL_ALIASES[String(model || 'sedan').toLowerCase()] || 'sedan';
  const list = MODEL_COLORS[key] || MODEL_COLORS.sedan;
  return list[Math.floor(rng.next() * list.length)];
}

let cityCache = null;
function cityOf(state) {
  if (state && state.city) return state.city;
  if (!cityCache) cityCache = buildCity(CFG.SEED);
  return cityCache;
}

function ensureArrays(state) {
  if (!Array.isArray(state.cars)) state.cars = [];
  if (!Array.isArray(state.traffic)) state.traffic = [];
  if (!Array.isArray(state.peds)) state.peds = [];
  if (!Array.isArray(state.police)) state.police = [];
  if (typeof state.wanted !== 'number') state.wanted = 0;
}

function nextCarId(state) {
  state._nextCarId = (state._nextCarId ?? 0) + 1;
  return `car-${state._nextCarId}`;
}

function nextPedId(state) {
  state._nextPedId = (state._nextPedId ?? 0) + 1;
  return `ped-${state._nextPedId}`;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function setToast(state, text, ttl = 3) {
  state.toast = { text, ttl };
}

/** A fresh, plain-data car object (JSON-safe, so save/load stays trivial). */
export function makeCar(id, x, y, angle, model, color) {
  const key = MODEL_ALIASES[String(model || 'sedan').toLowerCase()] || 'sedan';
  return {
    id, x, y, angle, speed: 0,
    color: color || pickColor(key),
    model: model || 'sedan',
    isPlayer: false,
    isPolice: key === 'police',
    parked: false,
  };
}

/** Read a driving vector from main.js's input (or its script staging override). */
export function driveInput(input) {
  if (!input) return { steer: 0, throttle: false, brake: false, boost: false };
  const src = input.script || input;
  let up = !!src.up;
  let down = !!src.down;
  let left = !!src.left;
  let right = !!src.right;
  let boost = !!src.boost;
  if (src.up === undefined && src.keys instanceof Set) {
    up = src.keys.has('KeyW') || src.keys.has('ArrowUp');
    down = src.keys.has('KeyS') || src.keys.has('ArrowDown');
    left = src.keys.has('KeyA') || src.keys.has('ArrowLeft');
    right = src.keys.has('KeyD') || src.keys.has('ArrowRight');
    boost = src.keys.has('ShiftLeft') || src.keys.has('ShiftRight');
  }
  return { steer: (right ? 1 : 0) - (left ? 1 : 0), throttle: up, brake: down, boost };
}

// --- collision helpers -------------------------------------------------------

// True when the point (with radius r) would be inside a building or water.
function blockedAt(city, x, y, r) {
  return !!collidesBuilding(city, x, y, r) || isWater(city, x, y);
}

// Move an entity, sliding along buildings/water instead of entering them.
// Checks the centre plus nose and tail so a long car cannot clip a corner.
function moveWithCollision(city, e, nx, ny, r, halfLen = 0) {
  const blocked = (x, y) => {
    if (blockedAt(city, x, y, r)) return true;
    if (halfLen > 0) {
      const fx = Math.cos(e.angle);
      const fy = Math.sin(e.angle);
      if (blockedAt(city, x + fx * halfLen, y + fy * halfLen, r)) return true;
      if (blockedAt(city, x - fx * halfLen, y - fy * halfLen, r)) return true;
    }
    return false;
  };
  if (!blocked(nx, ny)) { e.x = nx; e.y = ny; return 'full'; }
  // A slide only counts when it actually moves: a no-op axis (ny === e.y
  // while driving straight east) must not mask the block.
  if (nx !== e.x && !blocked(nx, e.y)) { e.x = nx; return 'x'; }
  if (ny !== e.y && !blocked(e.x, ny)) { e.y = ny; return 'y'; }
  return 'blocked';
}

function findPlayerCar(state) {
  if (!state.player.inCar || !state.player.carId) return null;
  return state.cars.find((c) => c.id === state.player.carId) || null;
}

// --- player car physics ------------------------------------------------------

/**
 * Full standalone player-car model: acceleration, braking, reverse,
 * steering that scales with speed, light drift at high speed, an off-road
 * speed cap, and building/water collision that stops the car instead of
 * letting it through. Called by player.js when it lands; main.js's
 * fallbackPlayer performs the same driving until then, so updateVehicles
 * never calls this (driving twice per step would double the speed).
 */
export function updatePlayerCar(state, dt, input) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  const p = state.player;
  if (!p.inCar) return;
  const car = findPlayerCar(state);
  if (!car) {
    p.inCar = false; p.onFoot = true; p.carId = null; p.speed = 0;
    return;
  }
  const city = cityOf(state);
  const spec = modelSpec(car.model);
  const drive = driveInput(input);
  const boost = drive.boost ? CFG.CAR_BOOST_MULT : 1;
  const maxSpeed = spec.maxSpeed * boost;
  const onRoad = isRoad(city, car.x, car.y);
  const cappedMax = onRoad ? maxSpeed : Math.min(maxSpeed, 150);

  if (drive.throttle) {
    car.speed += spec.accel * (drive.boost ? 1.25 : 1) * dt;
  } else if (drive.brake) {
    car.speed -= (car.speed > 0 ? CFG.CAR_BRAKE : CFG.CAR_REVERSE_ACCEL) * dt;
  } else {
    car.speed *= Math.exp(-CFG.CAR_DRAG * dt);
    if (Math.abs(car.speed) < 4) car.speed = 0;
  }
  if (car.speed > cappedMax) car.speed = Math.max(cappedMax, car.speed - 600 * dt);
  car.speed = clamp(car.speed, -CFG.CAR_MAX_REVERSE, maxSpeed);

  // Steering scales with speed: no turning while parked, full lock rolling.
  const speedFactor = clamp(Math.abs(car.speed) / 160, 0, 1);
  const dir = car.speed >= 0 ? 1 : -1;
  car.angle += drive.steer * spec.turn * speedFactor * dir * dt;
  car.angle = normAngle(car.angle);

  // Light drift: a hard steer at speed slides the car sideways a little.
  const slipTarget = drive.steer * clamp(Math.abs(car.speed) / 300, 0, 1) * 30;
  car.slip = (car.slip ?? 0) + (slipTarget - (car.slip ?? 0)) * Math.min(1, 4 * dt);
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const px = -fy;
  const py = fx;
  const nx = car.x + (fx * car.speed + px * (car.slip ?? 0)) * dt;
  const ny = car.y + (fy * car.speed + py * (car.slip ?? 0)) * dt;
  const moved = moveWithCollision(city, car, nx, ny, 12, spec.length / 2 - 4);
  if (moved === 'blocked') car.speed *= -0.25; // bump: stop, do not pass through
  const c = clampToWorld(car.x, car.y, 24);
  car.x = c.x; car.y = c.y;

  resolveCarCollisions(state);
  checkPlayerCarVsPeds(state);
  p.x = car.x; p.y = car.y; p.angle = car.angle; p.speed = car.speed;
}

/** On-foot movement (standalone; main.js's fallbackPlayer owns it in-game). */
export function updatePlayerOnFoot(state, dt, input) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  const p = state.player;
  if (p.inCar) return;
  const city = cityOf(state);
  const drive = driveInput(input);
  let mx = drive.steer;
  let my = (drive.brake ? 1 : 0) - (drive.throttle ? 1 : 0);
  if (mx === 0 && my === 0) { p.speed = 0; return; }
  const len = Math.hypot(mx, my);
  mx /= len; my /= len;
  const speed = CFG.WALK_SPEED * (drive.boost ? 1.4 : 1);
  p.angle = Math.atan2(my, mx);
  p.speed = speed;
  moveWithCollision(city, p, p.x + mx * speed * dt, p.y + my * speed * dt, CFG.PLAYER_RADIUS);
  const c = clampToWorld(p.x, p.y, CFG.PLAYER_RADIUS);
  p.x = c.x; p.y = c.y;
}

// --- collisions (once per step; stamp-guarded) -------------------------------

/**
 * Separate overlapping cars and trade speed between them. Parked cars do
 * not move; the mission truck is heavy and is never shoved by the player.
 * A hard hit by the player car is a witnessed crime.
 */
export function resolveCarCollisions(state) {
  const stamp = state.time;
  if (state._vehStamp === stamp) return;
  state._vehStamp = stamp;
  ensureArrays(state);
  const all = [...state.cars, ...state.traffic, ...state.police];
  const playerCar = findPlayerCar(state);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      // Only pairs involving the player car: traffic sorts itself out
      // in updateTraffic, and cars passing in opposite lanes (24 px
      // apart) must not be slowed by this pass.
      if (playerCar && a !== playerCar && b !== playerCar) continue;
      if (!playerCar) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const minDist = 40;
      if (d >= minDist || d < 0.01) continue;
      // Lane-aware collision: cars are long, not circles. Two cars
      // 26 px apart centre-to-centre (right-hand lane +12 vs oncoming
      // -14) are passing in adjacent lanes, not colliding — a radial
      // 40 px test would grind every drive down a street to a halt and
      // stack wanted stars from oncoming traffic. Collide only when the
      // player car is (nearly) in the other car's path: within 34 px
      // along its line of travel and 22 px across it.
      const other = a === playerCar ? b : a;
      const ox = Math.cos(other.angle || 0);
      const oy = Math.sin(other.angle || 0);
      const vx = playerCar.x - other.x;
      const vy = playerCar.y - other.y;
      const lon = vx * ox + vy * oy;
      const lat = Math.abs(vx * oy - vy * ox);
      if (Math.abs(lon) >= 34 || lat >= 22) continue;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = minDist - d;
      const aFixed = a.parked || a.missionTruck;
      const bFixed = b.parked || b.missionTruck;
      if (!aFixed && !bFixed) {
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      } else if (!aFixed) {
        a.x -= nx * overlap; a.y -= ny * overlap;
      } else if (!bFixed) {
        b.x += nx * overlap; b.y += ny * overlap;
      }
      const closing = Math.abs((a.speed || 0) - (b.speed || 0));
      // A crash is only the player's crime when the PLAYER car is moving
      // fast. A parked or crawling player car rear-ended by traffic at
      // 185 px/s is the victim, not a criminal — it must not raise wanted
      // while the player sits still at an intersection.
      if (playerCar && (a === playerCar || b === playerCar) && closing > 150
        && Math.abs(playerCar.speed || 0) > 60) {
        if (addWanted(state, 1, 'tabrak')) setToast(state, 'Tabrakan! Polisi waspada.');
      }
      a.speed = (a.speed || 0) * 0.6;
      b.speed = (b.speed || 0) * 0.6;
      const ca = clampToWorld(a.x, a.y, 24);
      const cb = clampToWorld(b.x, b.y, 24);
      a.x = ca.x; a.y = ca.y; b.x = cb.x; b.y = cb.y;
    }
  }
}

/**
 * The player car and pedestrians. A fast hit knocks the pedestrian down
 * and is a crime; a slow touch just makes them step away. A Harbor Kings
 * guard takes damage instead of a plain knockdown (missions.js counts
 * guards by hp/alive).
 */
export function checkPlayerCarVsPeds(state) {
  const car = findPlayerCar(state);
  if (!car) return;
  const city = cityOf(state);
  for (const ped of state.peds) {
    if (ped.down) continue;
    const d = dist(car.x, car.y, ped.x, ped.y);
    if (d >= 30) continue;
    const speed = Math.abs(car.speed);
    if (ped.missionGuard && ped.alive !== false) {
      ped.hp = (ped.hp ?? 100) - 40;
      const px = -Math.sin(car.angle);
      const py = Math.cos(car.angle);
      ped.x += px * 26; ped.y += py * 26;
      if (ped.hp <= 0) { ped.alive = false; ped.down = true; }
      if (addWanted(state, 1, 'tabrak')) setToast(state, 'Kamu menabrak penjaga Harbor Kings!');
      continue;
    }
    if (speed > 60) {
      ped.down = true;
      ped.downTimer = 4;
      ped.state = 'flee';
      ped.fleeTimer = 2.5;
      const px = -Math.sin(car.angle);
      const py = Math.cos(car.angle);
      const nx = ped.x + px * 26;
      const ny = ped.y + py * 26;
      if (!blockedAt(city, nx, ny, CFG.PED_RADIUS)) { ped.x = nx; ped.y = ny; }
      state.dangerZone = { x: car.x, y: car.y, radius: 220, ttl: 1.5, kind: 'hit' };
      if (addWanted(state, 1, 'tabrak')) setToast(state, 'Kamu menabrak pejalan kaki!');
    } else {
      ped.state = 'flee';
      ped.fleeTimer = 1.5;
      ped.fleeX = car.x;
      ped.fleeY = car.y;
    }
  }
}

// --- enter / exit / steal ----------------------------------------------------

function nearestCarIn(list, x, y, maxDist, exclude) {
  let best = null;
  let bestD = maxDist;
  for (const car of list) {
    if (exclude && exclude(car)) continue;
    const d = dist(car.x, car.y, x, y);
    if (d < bestD) { best = car; bestD = d; }
  }
  return best;
}

/**
 * E: enter the nearest car within CFG.CAR_ENTER_DIST. Parked cars are
 * free; a moving traffic car is a theft — its driver climbs out as a
 * fleeing pedestrian and the theft is a crime when anyone sees it.
 * Police cars are locked, and the m6 mission truck cannot be entered.
 * A stolen traffic car moves into state.cars (see the header note).
 */
export function enterCar(state) {
  ensureArrays(state);
  const p = state.player;
  if (p.inCar || state.mode !== 'playing') return false;
  const parked = nearestCarIn(
    state.cars, p.x, p.y, CFG.CAR_ENTER_DIST,
    (c) => c.isPolice || c.missionTruck,
  );
  const moving = nearestCarIn(
    state.traffic, p.x, p.y, CFG.CAR_ENTER_DIST,
    (c) => c.isPolice,
  );
  let car = null;
  let stolen = false;
  if (parked && moving) {
    car = dist(parked.x, parked.y, p.x, p.y) <= dist(moving.x, moving.y, p.x, p.y) ? parked : moving;
    stolen = car === moving;
  } else {
    car = parked || moving;
    stolen = !!moving && car === moving;
  }
  if (!car) return false;

  if (stolen) {
    const idx = state.traffic.indexOf(car);
    if (idx >= 0) state.traffic.splice(idx, 1);
    state.cars.push(car);
    car.parked = false;
    // The driver climbs out and runs.
    const side = car.angle + Math.PI / 2;
    const driver = {
      id: nextPedId(state),
      x: car.x + Math.cos(side) * 30,
      y: car.y + Math.sin(side) * 30,
      angle: car.angle,
      speed: 0,
      color: '#e0a458',
      down: false,
      from: -1, to: -1, t: 0, side: 1,
      state: 'flee',
      fleeTimer: 3,
      fleeX: car.x, fleeY: car.y,
    };
    const c = clampToWorld(driver.x, driver.y, CFG.PED_RADIUS);
    driver.x = c.x; driver.y = c.y;
    state.peds.push(driver);
    if (witnessed(state, car.x, car.y)) {
      if (addWanted(state, 1, 'curi mobil')) setToast(state, 'Kamu mencuri mobil! Polisi waspada.');
    } else {
      setToast(state, 'Mobil dicuri — tidak ada yang melihat.');
    }
  } else {
    car.parked = false;
    setToast(state, `Masuk ${car.model} — W gas, S rem, Shift boost`);
  }
  car.isPlayer = true;
  car.speed = 0;
  p.inCar = true;
  p.onFoot = false;
  p.carId = car.id;
  p.x = car.x; p.y = car.y; p.angle = car.angle; p.speed = 0;
  return true;
}

/**
 * E while driving: climb out beside the car. The first free side wins
 * (left, right, front, back); the car stays where it is, parked.
 */
export function exitCar(state) {
  ensureArrays(state);
  const p = state.player;
  if (!p.inCar || state.mode !== 'playing') return false;
  const city = cityOf(state);
  const car = findPlayerCar(state);
  if (car) {
    car.isPlayer = false;
    car.speed = 0;
    car.parked = true;
    const spots = [
      car.angle + Math.PI / 2, car.angle - Math.PI / 2,
      car.angle, car.angle + Math.PI,
    ];
    let placed = false;
    for (const a of spots) {
      const ex = car.x + Math.cos(a) * 36;
      const ey = car.y + Math.sin(a) * 36;
      if (!blockedAt(city, ex, ey, CFG.PLAYER_RADIUS)) {
        p.x = ex; p.y = ey; placed = true;
        break;
      }
    }
    if (!placed) { p.x = car.x; p.y = car.y; }
    const c = clampToWorld(p.x, p.y, CFG.PLAYER_RADIUS);
    p.x = c.x; p.y = c.y;
  }
  p.inCar = false;
  p.onFoot = true;
  p.carId = null;
  p.angle = car ? car.angle + Math.PI / 2 : p.angle;
  p.speed = 0;
  state._exitCooldown = 0.4;
  setToast(state, 'Keluar mobil');
  return true;
}

// --- parked cars ---------------------------------------------------------------

/**
 * Park `count` cars at the edge of the road: 26 px off the centreline, so
 * the lane stays passable and the car never sits inside a building, in
 * water, on a crosswalk, or on top of another car. Parked cars keep the
 * world feeling full between the 8 scripted spots B1 places at boot.
 */
export function spawnParkedCars(state, count = 6) {
  ensureArrays(state);
  const city = cityOf(state);
  const nodes = city.roadGraph.nodes;
  let placed = 0;
  let tries = 0;
  while (placed < count && tries < count * 40 + 20) {
    tries += 1;
    const road = city.roads[Math.floor(rng.next() * city.roads.length)];
    const len = Math.hypot(road.x2 - road.x1, road.y2 - road.y1);
    const t = 60 + rng.next() * Math.max(1, len - 120);
    const ux = (road.x2 - road.x1) / len;
    const uy = (road.y2 - road.y1) / len;
    const side = rng.next() < 0.5 ? 1 : -1;
    // Right-hand perpendicular of the road direction, 26 px out.
    const px = -uy * side;
    const py = ux * side;
    const x = road.x1 + ux * t + px * 26;
    const y = road.y1 + uy * t + py * 26;
    const angle = Math.atan2(uy, ux) + (rng.next() < 0.5 ? 0 : Math.PI);
    if (blockedAt(city, x, y, 20)) continue;
    if (dist(x, y, state.player.x, state.player.y) < 120) continue;
    let nearNode = false;
    for (const n of nodes) {
      if (dist(x, y, n.x, n.y) < 70) { nearNode = true; break; }
    }
    if (nearNode) continue; // keep intersections and crosswalks clear
    let crowded = false;
    for (const car of [...state.cars, ...state.traffic]) {
      if (dist(x, y, car.x, car.y) < 90) { crowded = true; break; }
    }
    if (crowded) continue; // room to pull out: no bumper-to-bumper rows
    const roll = rng.next();
    const model = roll < 0.4 ? 'sedan' : roll < 0.55 ? 'taxi' : roll < 0.7 ? 'van' : roll < 0.85 ? 'truck' : 'sport';
    const car = makeCar(nextCarId(state), x, y, angle, model);
    car.parked = true;
    state.cars.push(car);
    placed += 1;
  }
  return placed;
}

// --- traffic -------------------------------------------------------------------

function edgeEndpoints(city, a, b) {
  const na = city.roadGraph.nodes[a];
  const nb = city.roadGraph.nodes[b];
  return { na, nb };
}

// Pick a random road edge (two neighbouring intersections) and a point on it.
function randomEdgePoint(city) {
  const nodes = city.roadGraph.nodes;
  const a = nodes[Math.floor(rng.next() * nodes.length)];
  const options = city.roadGraph.adj.get(a.id) || [];
  if (options.length === 0) return { a: a.id, b: a.id, x: a.x, y: a.y, angle: 0 };
  const b = nodes[options[Math.floor(rng.next() * options.length)]];
  const t = 0.15 + rng.next() * 0.7;
  return {
    a: a.id, b: b.id,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Fill state.traffic up to `count` cars driving the road graph. */
export function spawnTraffic(state, count = CFG.TRAFFIC_COUNT) {
  ensureArrays(state);
  const city = cityOf(state);
  let added = 0;
  let guard = 0;
  while (state.traffic.length < count && guard < count * 10 + 10) {
    guard += 1;
    const pt = randomEdgePoint(city);
    if (pt.a === pt.b) continue;
    // Never spawn on top of a pedestrian.
    let tooClose = false;
    for (const ped of state.peds) {
      if (dist(pt.x, pt.y, ped.x, ped.y) < 60) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const roll = rng.next();
    const model = roll < 0.45 ? 'sedan' : roll < 0.6 ? 'taxi' : roll < 0.75 ? 'van' : roll < 0.9 ? 'truck' : 'sport';
    const car = makeCar(nextCarId(state), pt.x, pt.y, pt.angle, model);
    car.speed = CFG.TRAFFIC_SPEED * (0.85 + rng.next() * 0.25);
    car.nodeFrom = pt.a;
    car.nodeTo = pt.b;
    car.cruise = car.speed;
    car.waitTimer = 0;
    car.stuckTimer = 0;
    car.lane = 12; // right-hand lane, px off the centreline
    car.laneTarget = 12;
    car.abandoned = false;
    state.traffic.push(car);
    added += 1;
  }
  return added;
}

// The car ahead of `car` on its lane, if any: { car, gap }.
function carAhead(state, car, range) {
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  let best = null;
  let bestAlong = range;
  const others = [...state.traffic, ...state.police, ...state.cars];
  for (const other of others) {
    if (other === car) continue;
    // Oncoming cars drive the other lane and pass clear of this one;
    // only same-direction cars (and parked, abandoned or player cars)
    // can queue ahead.
    const sameDir = Math.cos((other.angle || 0) - car.angle) > 0.5;
    if (!sameDir && !other.parked && !other.abandoned && !other.isPlayer) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const along = dx * fx + dy * fy;
    if (along <= 0 || along > range) continue;
    const side = Math.abs(dx * -fy + dy * fx);
    if (side > 26) continue;
    if (along < bestAlong) { best = other; bestAlong = along; }
  }
  return best ? { car: best, gap: bestAlong - 46 } : null;
}

// A pedestrian in `car`'s path: ahead, close to the centreline, and
// actually on the asphalt (or crossing / fleeing across it). Someone
// walking on the sidewalk beside the road is not in the way, even
// though they are close to the car's side.
function pedInPath(city, state, car, range) {
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  for (const ped of state.peds) {
    if (ped.down) continue;
    const dx = ped.x - car.x;
    const dy = ped.y - car.y;
    const along = dx * fx + dy * fy;
    if (along <= 0 || along > range) continue;
    const side = Math.abs(dx * -fy + dy * fx);
    if (side > 30) continue;
    if (ped.state !== 'cross' && ped.state !== 'flee') {
      const near = nearestRoad(city, ped.x, ped.y);
      if (near && near.dist > 32) continue; // on the sidewalk, not the road
    }
    return ped;
  }
  return null;
}

/**
 * Traffic AI (main.js step 3 via traffic.js). Cars drive node to node
 * along the road graph in the right-hand lane, queue behind the car ahead,
 * yield at an intersection when another car is already crossing it, stop
 * for pedestrians in their path, and never stack on top of each other.
 * A car that is stuck or somehow off the road is put back on a road edge
 * instead of soft-locking the street.
 */
export function updateTraffic(state, dt) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  const city = cityOf(state);
  spawnTraffic(state, CFG.TRAFFIC_COUNT);
  const p = state.player;

  for (const car of state.traffic) {
    if (car.abandoned) continue; // shot-out car: an obstacle, not a driver
    const { na, nb } = edgeEndpoints(city, car.nodeFrom, car.nodeTo);
    if (!na || !nb) {
      const pt = randomEdgePoint(city);
      car.nodeFrom = pt.a; car.nodeTo = pt.b; car.x = pt.x; car.y = pt.y;
      continue;
    }
    const nodeDist = dist(car.x, car.y, nb.x, nb.y);
    if (nodeDist < 26) {
      const oldFrom = car.nodeFrom;
      const options = (city.roadGraph.adj.get(car.nodeTo) || []).filter((id) => id !== oldFrom);
      car.nodeFrom = car.nodeTo;
      // No onward edge (no dead ends in this grid, but be safe): turn back.
      car.nodeTo = options.length
        ? options[Math.floor(rng.next() * options.length)]
        : oldFrom;
      continue;
    }

    // Lane target: a look-ahead point on this edge's lane line. Aiming
    // at the far node cuts the corner across the sidewalk; aiming at the
    // lane line keeps the car on the asphalt through the turn.
    const ex = nb.x - na.x;
    const ey = nb.y - na.y;
    const edgeLen = Math.hypot(ex, ey) || 1;
    const ux = ex / edgeLen;
    const uy = ey / edgeLen;
    const sAlong = clamp(((car.x - na.x) * ux + (car.y - na.y) * uy) / edgeLen, 0, 1);
    const look = Math.min(edgeLen, sAlong * edgeLen + 60);
    const tx = na.x + ux * look + -uy * car.lane;
    const ty = na.y + uy * look + ux * car.lane;

    let desired = car.cruise;

    // Queue: ease to a stop behind the car ahead (never overlap it).
    // A parked, abandoned or stopped car is swerved around instead of
    // queued on: the lane target moves to the far side while passing it.
    const ahead = carAhead(state, car, 120);
    const aheadStopped = ahead && (
      ahead.car.parked || ahead.car.abandoned || (ahead.car.speed ?? 0) < 5
    );
    if (aheadStopped) {
      car.laneTarget = -14;
    } else {
      car.laneTarget = 12;
      if (ahead) {
        if (ahead.gap < 26) desired = 0;
        else if (ahead.gap < 60) desired = Math.min(desired, car.cruise * ((ahead.gap - 26) / 34));
      }
    }
    car.lane += clamp((car.laneTarget ?? 12) - car.lane, -40 * dt, 40 * dt);

    // Intersection: wait when another car is already crossing this node.
    if (nodeDist < 70) {
      for (const other of [...state.traffic, ...state.police]) {
        if (other === car) continue;
        const od = dist(other.x, other.y, nb.x, nb.y);
        if (od < 90 && od < nodeDist) { desired = 0; break; }
      }
    }

    // Pedestrians: stop for anyone in the path, crossing or not.
    // A longer look-ahead and hard braking: a pedestrian can step out
    // while the car is already close, and the car must still stop short.
    if (pedInPath(city, state, car, 110)) desired = 0;

    // The player on foot in the road: stop, do not run them over.
    if (!p.inCar && dist(car.x, car.y, p.x, p.y) < 55) {
      const along = (p.x - car.x) * Math.cos(car.angle) + (p.y - car.y) * Math.sin(car.angle);
      if (along > 0) desired = 0;
    }

    if (desired === 0 && car.speed < 5) {
      car.speed = 0;
      car.waitTimer = (car.waitTimer ?? 0) + dt;
    } else {
      car.waitTimer = 0;
      if (car.speed < desired) car.speed = Math.min(desired, car.speed + 220 * dt);
      else if (car.speed > desired) car.speed = Math.max(desired, car.speed - 700 * dt);
    }

    const wantAngle = Math.atan2(ty - car.y, tx - car.x);
    car.angle += clamp(normAngle(wantAngle - car.angle), -2.6 * dt, 2.6 * dt);
    const moved = moveWithCollision(city, car, car.x + Math.cos(car.angle) * car.speed * dt, car.y + Math.sin(car.angle) * car.speed * dt, 12, 18);
    if (moved === 'blocked') car.speed = 0;
    const c = clampToWorld(car.x, car.y, 24);
    car.x = c.x; car.y = c.y;

    // Stuck or off the road: put the car back on a road edge.
    const near = nearestRoad(city, car.x, car.y);
    if ((car.speed < 5 && desired > 0) || (near && near.dist > 120)) {
      car.stuckTimer = (car.stuckTimer ?? 0) + dt;
    } else {
      car.stuckTimer = 0;
    }
    if ((car.stuckTimer ?? 0) > 6) {
      const pt = randomEdgePoint(city);
      car.nodeFrom = pt.a; car.nodeTo = pt.b;
      car.x = pt.x; car.y = pt.y; car.angle = pt.angle;
      car.speed = car.cruise; car.stuckTimer = 0;
    }
  }

  // Separation: traffic cars never stack on each other or on parked cars.
  const movers = state.traffic.filter((c) => !c.abandoned);
  const solids = [...state.cars, ...state.police];
  for (const car of movers) {
    for (const other of [...movers, ...solids]) {
      if (other === car) continue;
      const dx = car.x - other.x;
      const dy = car.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d >= 38 || d < 0.01) continue;
      const push = (38 - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      if (solids.includes(other)) {
        car.x += nx * push * 2; car.y += ny * push * 2;
      } else {
        car.x += nx * push; car.y += ny * push;
        other.x -= nx * push; other.y -= ny * push;
      }
      const cc = clampToWorld(car.x, car.y, 24);
      car.x = cc.x; car.y = cc.y;
    }
  }
}

// --- main.js step-2 entry point -----------------------------------------------

let prevKeys = new Set();

/**
 * The main.js step-2 entry point. main.js's fallbackPlayer owns locomotion
 * (on foot and the player car) until player.js lands, so this does NOT
 * drive the car again. It tops up parked cars, lets the player steal a
 * traffic car with E (main.js's own KeyE handler only reaches parked
 * cars in state.cars), and resolves car/car and car/pedestrian collisions
 * once per step. It also keeps the player glued to their car.
 */
export function updateVehicles(state, dt, input) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  state._exitCooldown = Math.max(0, (state._exitCooldown ?? 0) - dt);

  // Keep the streets full: B1 places 8 parked cars at boot; top up to 14.
  const parkedCount = state.cars.filter((c) => !c.missionCar && !c.missionTruck).length;
  if (parkedCount < 14) spawnParkedCars(state, 14 - parkedCount);

  // Steal a traffic car with E. main.js consumes the KeyE edge in step 1,
  // so this edge-detects the held key itself; the exit cooldown stops an
  // instant re-steal after climbing out next to a traffic car.
  if (input && !input.script && input.keys instanceof Set) {
    const pressedE = input.keys.has('KeyE') && !prevKeys.has('KeyE');
    if (pressedE && state.player.onFoot && (state._exitCooldown ?? 0) <= 0) {
      const near = nearestCarIn(state.traffic, state.player.x, state.player.y, CFG.CAR_ENTER_DIST, (c) => c.isPolice);
      if (near) enterCar(state);
    }
    prevKeys = new Set(input.keys);
  }

  if (state.player.inCar) {
    const car = findPlayerCar(state);
    if (!car) {
      state.player.inCar = false;
      state.player.onFoot = true;
      state.player.carId = null;
      state.player.speed = 0;
    } else {
      resolveCarCollisions(state);
      checkPlayerCarVsPeds(state);
      state.player.x = car.x;
      state.player.y = car.y;
      state.player.angle = car.angle;
      state.player.speed = car.speed;
    }
  }
}
