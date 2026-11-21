// police.js — Port Verda (Builder B2: Vehicles & Life).
//
// Wanted level, police pursuit, ramming, blocking, bust / wasted.
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
//   state.time is seconds of play. state.wanted is an integer 0..5.
//   A police car is { id, x, y, angle, speed, color, model: 'Patrol',
//   isPlayer: false, isPolice: true, lastRam, bustTimer, stuckTimer } and
//   lives in state.police only (render.js draws state.police separately;
//   it is never in state.cars, so it can never be entered).
//
// WIRING (main.js B1): step 5 calls updatePolice(state, dt) every step
// while playing. spawnPolice / updateWanted / bustCheck / addWanted are
// exported for the other B2 modules (vehicles.js, combat.js) and for tests;
// main.js performs its own wanted decay with wantedTimer, so updateWanted
// is the standalone equivalent, not a second decay pass.
//
// SAFETY (lesson from v1): a police ram NEVER pushes anything out of the
// world. Every ram displacement is capped (RAM_PUSH_PX) and every police
// and player-car position is clamped with city.clampToWorld after every
// move; main.js also runs clampAllPositions() at the end of each step.

import { CFG } from './config.js';
import { buildCity, clampToWorld, collidesBuilding, isWater } from './city.js';
import { createRng } from './rng.js';
import { saveGame } from './save.js';
import { initAudio, playPunch, playBusted, playWasted } from './audio.js';

const rng = createRng(CFG.SEED + 101);

// Ram: the push is a short shove, never a launch. Damage matches CFG.
const RAM_PUSH_PX = 22;
const RAM_RANGE = 54;
const BUST_RANGE = 75; // police must be this close for the bust timer to grow
const BUST_SECONDS = 2; // close + slow for this long -> busted
const PLAYER_SLOW = 45; // px/s: above this the player cannot be busted
const DESPAWN_DIST = 900; // police with no wanted level leave past this
const STUCK_SECONDS = 5;

// How many patrol cars each wanted level fields.
export function policeCountForWanted(wanted) {
  if (wanted <= 0) return 0;
  if (wanted <= 2) return 1;
  if (wanted === 3) return 2;
  if (wanted === 4) return 3;
  return 4;
}

let cityCache = null;
function cityOf(state) {
  if (state && state.city) return state.city;
  if (!cityCache) cityCache = buildCity(CFG.SEED);
  return cityCache;
}

function ensureArrays(state) {
  if (!Array.isArray(state.police)) state.police = [];
  if (!Array.isArray(state.cars)) state.cars = [];
  if (!Array.isArray(state.traffic)) state.traffic = [];
  if (!Array.isArray(state.peds)) state.peds = [];
  if (!Array.isArray(state.enemies)) state.enemies = [];
  if (typeof state.wanted !== 'number') state.wanted = 0;
  if (typeof state.health !== 'number') state.health = CFG.PLAYER_MAX_HEALTH;
}

function nextPoliceId(state) {
  state._nextPoliceId = (state._nextPoliceId ?? 0) + 1;
  return `police-${state._nextPoliceId}`;
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

// Police sounds (B3 audio.js). main.js's createAudio wiring does not
// exist in audio.js, so this module starts the shared AudioContext
// lazily (see combat.js) and respects the game's mute flag.
let audioStarted = false;
function policeSound(state, play) {
  if (state.muted) return;
  if (!audioStarted) {
    audioStarted = true;
    try { initAudio(); } catch { /* audio never breaks the game */ }
  }
  try { play(); } catch { /* audio never breaks the game */ }
}

/**
 * Is a crime at (x, y) seen by anyone? A patrol car within 500 px or a
 * pedestrian / gang member on their feet within 300 px counts as a witness.
 * Crimes nobody sees do not raise the wanted level.
 */
export function witnessed(state, x, y) {
  for (const car of state.police || []) {
    if (dist(car.x, car.y, x, y) <= 500) return true;
  }
  for (const ped of state.peds || []) {
    if (!ped.down && dist(ped.x, ped.y, x, y) <= 300) return true;
  }
  for (const e of state.enemies || []) {
    if (e.alive !== false && dist(e.x, e.y, x, y) <= 300) return true;
  }
  return false;
}

/**
 * Raise the wanted level by n stars (clamped to CFG.WANTED_MAX) and restart
 * the decay clock, exactly like main.js's own addWanted. The same reason
 * cannot raise it twice within 1.5 s, so one crash does not stack stars.
 * Returns true when the level actually rose.
 */
export function addWanted(state, n, reason = 'crime') {
  if (!state) return false;
  ensureArrays(state);
  if (state.mode === 'busted' || state.mode === 'wasted') return false;
  const now = typeof state.time === 'number' ? state.time : 0;
  state._crimeAt = state._crimeAt || {};
  if (reason && now - (state._crimeAt[reason] ?? -100) < 1.5) return false;
  if (reason) state._crimeAt[reason] = now;
  const before = Math.round(state.wanted);
  state.wanted = clamp(before + Math.round(n), 0, CFG.WANTED_MAX);
  state.wantedTimer = 0;
  state._wantedIdle = 0;
  if (state.wanted > before) state.lastCrime = reason;
  return state.wanted > before;
}

/**
 * Standalone wanted decay: one star drops after WANTED_DECAY_SECONDS with
 * no new crime and no patrol car within 550 px. main.js runs its own
 * equivalent decay every step, so this is for tests and standalone use —
 * it is NOT called by updatePolice, and must never run twice per step.
 */
export function updateWanted(state, dt) {
  ensureArrays(state);
  if (state.wanted <= 0) {
    state._wantedIdle = 0;
    return;
  }
  state._wantedIdle = (state._wantedIdle ?? 0) + dt;
  let policeNear = false;
  for (const car of state.police) {
    if (dist(car.x, car.y, state.player.x, state.player.y) <= 550) { policeNear = true; break; }
  }
  if (!policeNear && state._wantedIdle >= CFG.WANTED_DECAY_SECONDS) {
    state.wanted = Math.max(0, Math.round(state.wanted) - 1);
    state._wantedIdle = 0;
    if (state.wanted === 0) setToast(state, 'Polisi kehilangan jejakmu.');
  }
}

/** Spawn patrol cars until the count matches the wanted level. */
export function spawnPolice(state) {
  ensureArrays(state);
  const city = cityOf(state);
  const want = policeCountForWanted(Math.round(state.wanted));
  while (state.police.length > want) state.police.pop();
  let guard = 0;
  while (state.police.length < want && guard < 6) {
    guard += 1;
    let pt = null;
    for (let tries = 0; tries < 8; tries++) {
      const cand = city.randomRoadPoint(rng);
      const d = dist(cand.x, cand.y, state.player.x, state.player.y);
      if (d >= CFG.POLICE_SPAWN_DIST && d <= 950) { pt = cand; break; }
      if (!pt) pt = cand;
    }
    if (!pt) return;
    state.police.push({
      id: nextPoliceId(state),
      x: pt.x,
      y: pt.y,
      angle: Math.atan2(state.player.y - pt.y, state.player.x - pt.x),
      speed: 0,
      color: '#20242a',
      model: 'Patrol',
      isPlayer: false,
      isPolice: true,
      lastRam: 0,
      bustTimer: 0,
      stuckTimer: 0,
    });
  }
}

function nearestNode(city, x, y) {
  let best = city.roadGraph.nodes[0];
  let bestD = Infinity;
  for (const n of city.roadGraph.nodes) {
    const d = dist(n.x, n.y, x, y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function playerCar(state) {
  if (!state.player.inCar || !state.player.carId) return null;
  return state.cars.find((c) => c.id === state.player.carId) || null;
}

function playerSpeed(state) {
  const car = playerCar(state);
  if (car) return Math.abs(car.speed);
  return Math.abs(state.player.speed || 0);
}

// Move a car one step, sliding along buildings and water instead of
// entering them. Returns true when the full move succeeded.
function moveCar(city, car, nx, ny, r = 20) {
  const blocked = (x, y) => collidesBuilding(city, x, y, r) || isWater(city, x, y);
  if (!blocked(nx, ny)) { car.x = nx; car.y = ny; return true; }
  // A slide only counts when it actually moves (see vehicles.js).
  if (nx !== car.x && !blocked(nx, car.y)) { car.x = nx; return true; }
  if (ny !== car.y && !blocked(car.x, ny)) { car.y = ny; return true; }
  return false;
}

function pedAhead(city, state, car, range) {
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  for (const ped of state.peds) {
    if (ped.down || ped.missionGuard) continue;
    const dx = ped.x - car.x;
    const dy = ped.y - car.y;
    const along = dx * fx + dy * fy;
    if (along <= 0 || along > range) continue;
    const side = Math.abs(dx * -fy + dy * fx);
    if (side > 30) continue;
    // Someone walking on the sidewalk is not in the way (see vehicles.js).
    if (ped.state !== 'cross' && ped.state !== 'flee') {
      const near = city.nearestRoad(ped.x, ped.y);
      if (near && near.dist > 32) continue;
    }
    return true;
  }
  return false;
}

/**
 * Bust / wasted check. A patrol car very close to a slow player (on foot
 * or crawling) builds its bust timer; 2 s of that and the player is
 * busted. Health at 0 is wasted. Called by updatePolice every step.
 */
export function bustCheck(state, dt) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  if (state.health <= 0) {
    state.health = 0;
    state.mode = 'wasted';
    policeSound(state, playWasted);
    try { saveGame(state); } catch { /* saving never breaks the game */ }
    return;
  }
  const speed = playerSpeed(state);
  let busted = false;
  for (const car of state.police) {
    const d = dist(car.x, car.y, state.player.x, state.player.y);
    if (d < BUST_RANGE && speed < PLAYER_SLOW) {
      car.bustTimer = (car.bustTimer ?? 0) + dt;
      if (car.bustTimer >= BUST_SECONDS) busted = true;
    } else {
      car.bustTimer = Math.max(0, (car.bustTimer ?? 0) - dt * 2);
    }
  }
  if (busted) {
    state.mode = 'busted';
    setToast(state, 'Tertangkap! Tekan Enter untuk mulai lagi.');
    policeSound(state, playBusted);
    try { saveGame(state); } catch { /* saving never breaks the game */ }
  }
}

/**
 * The main.js step-5 entry point. Spawns / despawns patrol cars for the
 * current wanted level, chases the player, blocks a fast car from the
 * front, rams with a capped shove, yields to crossing pedestrians, and
 * never lets a ram or a chase push anything out of the world.
 */
export function updatePolice(state, dt) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  const city = cityOf(state);
  const p = state.player;
  const wanted = Math.round(state.wanted);

  spawnPolice(state);

  // No wanted level: patrol cars drive off and leave past 900 px.
  if (wanted === 0) {
    for (let i = state.police.length - 1; i >= 0; i--) {
      const car = state.police[i];
      const away = Math.atan2(car.y - p.y, car.x - p.x);
      car.angle += clamp(normAngle(away - car.angle), -2.5 * dt, 2.5 * dt);
      car.speed = Math.min(220, car.speed + 200 * dt);
      moveCar(city, car, car.x + Math.cos(car.angle) * car.speed * dt, car.y + Math.sin(car.angle) * car.speed * dt);
      const c = clampToWorld(car.x, car.y, 24);
      car.x = c.x; car.y = c.y;
      if (dist(car.x, car.y, p.x, p.y) > DESPAWN_DIST) state.police.splice(i, 1);
    }
    return;
  }

  const car = playerCar(state);
  const pSpeed = playerSpeed(state);
  const lead = car ? 0.35 : 0;
  const tx = p.x + (car ? Math.cos(car.angle) * car.speed * lead : 0);
  const ty = p.y + (car ? Math.sin(car.angle) * car.speed * lead : 0);
  const maxSpeed = 380 + 18 * wanted; // 398..470, CFG.POLICE_CHASE_SPEED at 5 stars

  for (const cop of state.police) {
    cop.lastRam = Math.max(0, (cop.lastRam ?? 0) - dt);
    const dx = tx - cop.x;
    const dy = ty - cop.y;
    const d = Math.hypot(dx, dy) || 1;
    let wantAngle = Math.atan2(dy, dx);
    let targetSpeed = maxSpeed;

    // Close quarters (<140 px): steer straight at the player, for the
    // ram and the bust. Further out, follow the road graph node to node
    // toward the player's node — a straight-line chase cuts through
    // buildings and gets stuck on them.
    if (d >= 140) {
      const goal = nearestNode(city, p.x, p.y);
      if (cop.route == null) cop.route = nearestNode(city, cop.x, cop.y).id;
      let rn = city.roadGraph.nodes[cop.route];
      if (!rn || dist(cop.x, cop.y, rn.x, rn.y) > 400) {
        cop.route = nearestNode(city, cop.x, cop.y).id;
        rn = city.roadGraph.nodes[cop.route];
      }
      if (rn && dist(cop.x, cop.y, rn.x, rn.y) < 30) {
        let best = cop.route;
        let bestD = Infinity;
        for (const id of city.roadGraph.adj.get(cop.route) || []) {
          const n = city.roadGraph.nodes[id];
          const dd = dist(n.x, n.y, goal.x, goal.y);
          if (dd < bestD) { bestD = dd; best = id; }
        }
        cop.route = best;
      }
      const target = city.roadGraph.nodes[cop.route];
      if (target) wantAngle = Math.atan2(target.y - cop.y, target.x - cop.x);
    }

    // Pull up and stop beside a slow player: the bust timer only grows
    // while a patrol car stays close, and a car at full speed overshoots.
    if (pSpeed < PLAYER_SLOW && d < 100) targetSpeed = 0;

    // Block: a fast player car gets a patrol car stopping in its path.
    if (car && pSpeed > 150) {
      const fx = Math.cos(car.angle);
      const fy = Math.sin(car.angle);
      const toCopX = (cop.x - car.x) / d;
      const toCopY = (cop.y - car.y) / d;
      if (fx * toCopX + fy * toCopY > 0.7 && d < 150) {
        wantAngle = Math.atan2(p.y + fy * 60 - cop.y, p.x + fx * 60 - cop.x);
        targetSpeed = 0;
      }
    }

    // Never run over a pedestrian: stop for anyone crossing ahead.
    if (pedAhead(city, state, cop, 70)) targetSpeed = 0;

    cop.angle += clamp(normAngle(wantAngle - cop.angle), -3.2 * dt, 3.2 * dt);
    if (cop.speed < targetSpeed) cop.speed = Math.min(targetSpeed, cop.speed + 380 * dt);
    else if (cop.speed > targetSpeed) cop.speed = Math.max(targetSpeed, cop.speed - 600 * dt);

    const moved = moveCar(
      city, cop,
      cop.x + Math.cos(cop.angle) * cop.speed * dt,
      cop.y + Math.sin(cop.angle) * cop.speed * dt,
    );
    const c = clampToWorld(cop.x, cop.y, 24);
    cop.x = c.x; cop.y = c.y;

    // Stuck against a building or a queue: recover onto a road NEAR the
    // player — never a random point across the city, which reads as a
    // teleport. Sample road points and keep the first 250-650 px from
    // the player; if none turns up, stay put and just reset the timer:
    // a stuck cop that waits is better than one that teleports.
    if ((!moved || cop.speed < 12) && d > 250) cop.stuckTimer = (cop.stuckTimer ?? 0) + dt;
    else cop.stuckTimer = 0;
    if ((cop.stuckTimer ?? 0) > STUCK_SECONDS) {
      let pt = null;
      for (let tries = 0; tries < 12; tries++) {
        const cand = city.randomRoadPoint(rng);
        const dd = dist(cand.x, cand.y, p.x, p.y);
        if (dd >= 250 && dd <= 650) { pt = cand; break; }
      }
      if (pt) {
        cop.x = pt.x; cop.y = pt.y; cop.speed = 0;
        cop.route = nearestNode(city, pt.x, pt.y).id;
      }
      cop.stuckTimer = 0;
    }

    // Ram: a short, capped shove plus damage — never a launch, and the
    // player car is clamped to the world right after the shove.
    const after = dist(cop.x, cop.y, p.x, p.y);
    if (car && after < RAM_RANGE && (cop.lastRam ?? 0) <= 0) {
      cop.lastRam = 1;
      const px = Math.cos(cop.angle);
      const py = Math.sin(cop.angle);
      car.x += px * RAM_PUSH_PX;
      car.y += py * RAM_PUSH_PX;
      const cc = clampToWorld(car.x, car.y, 24);
      car.x = cc.x; car.y = cc.y;
      car.speed *= 0.55;
      cop.speed *= 0.6;
      if (p.invulnerable <= 0) {
        state.health = Math.max(0, state.health - CFG.POLICE_RAM_DAMAGE);
        p.invulnerable = 1;
        setToast(state, 'Polisi menabrak mobilmu!');
        policeSound(state, playPunch);
      }
      if (state.health <= 0) {
        state.health = 0;
        state.mode = 'wasted';
        policeSound(state, playWasted);
        try { saveGame(state); } catch { /* saving never breaks the game */ }
        return;
      }
    }
  }

  // Keep patrol cars from piling onto each other.
  for (let i = 0; i < state.police.length; i++) {
    for (let j = i + 1; j < state.police.length; j++) {
      const a = state.police[i];
      const b = state.police[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01 && d < 44) {
        const push = (44 - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        const ca = clampToWorld(a.x, a.y, 24);
        const cb = clampToWorld(b.x, b.y, 24);
        a.x = ca.x; a.y = ca.y; b.x = cb.x; b.y = cb.y;
      }
    }
  }

  bustCheck(state, dt);
}
