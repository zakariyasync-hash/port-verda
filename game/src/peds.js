// peds.js — Port Verda (Builder B2: Vehicles & Life).
//
// Pedestrian spawning and AI: sidewalk walking, crossing only at
// intersections, fleeing from danger, never standing in the road.
// Written from scratch in this session. Vanilla ES module, no library,
// no network, no external asset. Pure logic over the shared `state` object.
//
// STATE CONTRACT (agreed with B1 main.js / B3 missions.js):
//   state = { mode, time, money, health, wanted, wantedTimer,
//             player: { x, y, angle, speed, onFoot, inCar, carId, invulnerable },
//             cars: [], traffic: [], peds: [], police: [],
//             missions: { activeId, active, target, done: [], progress: {} },
//             camera: { x, y }, input, muted, fx: [], toast, city }
//   A pedestrian is { id, x, y, angle, speed, color, down,
//                     from, to, t, side, state, fleeTimer, waitTimer, crossT }.
//   `from` / `to` are road-graph node ids, `t` is 0..1 along that edge,
//   `side` is +1/-1 (which sidewalk), and `state` is one of
//   'walk' | 'flee' | 'idle-sidewalk' | 'cross'.
//   Pedestrians walk on the sidewalk: 39 px off the road centreline
//   (road half-width 32 + half the 14 px sidewalk). They cross a road
//   ONLY at an intersection, switching sides there; traffic (vehicles.js)
//   stops for anyone in its path, and this module pushes a pedestrian
//   out of the way as a last resort, so a pedestrian is never run over
//   by traffic while idle.
//
// WIRING (main.js B1): step 4 calls updatePeds(state, dt) every step
// while playing; the title screen keeps using main.js's fallbackPeds,
// so updatePeds normalises any pedestrian the fallback created
// (from/to/t/side shape) instead of assuming its own fields exist.
// Mission guards (B3 missions.js) live in state.peds with
// missionGuard:true — they stand their post and are never walked by
// this module; combat.js handles them.

import { CFG } from './config.js';
import { buildCity, clampToWorld, collidesBuilding, isWater, nearestRoad } from './city.js';
import { createRng } from './rng.js';

const rng = createRng(CFG.SEED + 303);

// Sidewalk centre, px off the road centreline (32 road half + 7 half sidewalk).
const SIDEWALK_OFF = CFG.ROAD_W / 2 + CFG.SIDEWALK / 2; // 39
const FLEE_SPEED = 165;
const PED_COLORS = ['#e8dcc0', '#7fb069', '#c17a9e', '#e0a458', '#8ecae6', '#f4f1de'];

let cityCache = null;
function cityOf(state) {
  if (state && state.city) return state.city;
  if (!cityCache) cityCache = buildCity(CFG.SEED);
  return cityCache;
}

function ensureArrays(state) {
  if (!Array.isArray(state.peds)) state.peds = [];
  if (!Array.isArray(state.traffic)) state.traffic = [];
  if (!Array.isArray(state.police)) state.police = [];
  if (!Array.isArray(state.cars)) state.cars = [];
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

// Unit perpendicular (right-hand side) of a direction vector.
function perpOf(dx, dy, len) {
  return { x: -dy / len, y: dx / len };
}

function edgePoint(a, b, t, side) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  return {
    x: a.x + dx * t + px * side * SIDEWALK_OFF,
    y: a.y + dy * t + py * side * SIDEWALK_OFF,
    angle: Math.atan2(dy, dx),
    px, py,
  };
}

// Fill in every field updatePeds needs; tolerates fallback-spawned peds.
function ensurePed(ped) {
  if (typeof ped.speed !== 'number') ped.speed = CFG.PED_SPEED;
  if (typeof ped.color !== 'string') ped.color = PED_COLORS[0];
  if (typeof ped.down !== 'boolean') ped.down = false;
  if (typeof ped.t !== 'number') ped.t = 0;
  if (typeof ped.side !== 'number') ped.side = 1;
  if (typeof ped.state !== 'string') ped.state = 'walk';
  if (typeof ped.fleeTimer !== 'number') ped.fleeTimer = 0;
  if (typeof ped.waitTimer !== 'number') ped.waitTimer = 0;
  if (typeof ped.crossT !== 'number') ped.crossT = 0;
  if (typeof ped.downTimer !== 'number') ped.downTimer = 0;
  return ped;
}

/**
 * Find the road edge under (x, y): the two intersection nodes bracketing
 * the nearest point on the nearest road, the position along that edge,
 * and which sidewalk the point is on. Used to put a fleeing pedestrian
 * back on a sidewalk.
 */
function edgeFromRoadPoint(city, x, y) {
  const near = nearestRoad(city, x, y);
  if (!near) return null;
  const yRoads = [...CFG.STREETS, CFG.PROMENADE_Y];
  if (near.vertical) {
    const ix = CFG.AVENUES.indexOf(near.x);
    if (ix < 0) return null;
    let iy = 0;
    while (iy < yRoads.length - 2 && y > yRoads[iy + 1]) iy++;
    const from = city.roadGraph.nodes[iy * CFG.AVENUES.length + ix];
    const to = city.roadGraph.nodes[(iy + 1) * CFG.AVENUES.length + ix];
    if (!from || !to) return null;
    return {
      from: from.id, to: to.id,
      t: clamp((y - from.y) / Math.max(1, to.y - from.y), 0, 1),
      side: x < near.x ? 1 : -1,
    };
  }
  const iy = yRoads.indexOf(near.y);
  if (iy < 0) return null;
  let ix = 0;
  while (ix < CFG.AVENUES.length - 2 && x > CFG.AVENUES[ix + 1]) ix++;
  const from = city.roadGraph.nodes[iy * CFG.AVENUES.length + ix];
  const to = city.roadGraph.nodes[iy * CFG.AVENUES.length + ix + 1];
  if (!from || !to) return null;
  return {
    from: from.id, to: to.id,
    t: clamp((x - from.x) / Math.max(1, to.x - from.x), 0, 1),
    side: y > near.y ? 1 : -1,
  };
}

/** Fill state.peds up to `count` pedestrians walking the sidewalks. */
export function spawnPeds(state, count = CFG.PED_COUNT) {
  ensureArrays(state);
  const city = cityOf(state);
  const nodes = city.roadGraph.nodes;
  let added = 0;
  let guard = 0;
  while (state.peds.length < count && guard < count * 10 + 10) {
    guard += 1;
    const a = nodes[Math.floor(rng.next() * nodes.length)];
    const options = city.roadGraph.adj.get(a.id) || [];
    if (options.length === 0) continue;
    const b = nodes[options[Math.floor(rng.next() * options.length)]];
    const idle = rng.next() < 0.15;
    const ped = ensurePed({
      id: nextPedId(state),
      x: a.x, y: a.y,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      speed: CFG.PED_SPEED * (0.8 + rng.next() * 0.5),
      color: PED_COLORS[Math.floor(rng.next() * PED_COLORS.length)],
      down: false,
      from: a.id, to: b.id,
      t: 0.05 + rng.next() * 0.9,
      side: rng.next() < 0.5 ? 1 : -1,
      state: idle ? 'idle-sidewalk' : 'walk',
      waitTimer: idle ? 2 + rng.next() * 4 : 0,
    });
    const pt = edgePoint(a, b, ped.t, ped.side);
    ped.x = pt.x; ped.y = pt.y; ped.angle = pt.angle;
    // Never spawn on top of a car.
    let tooClose = false;
    for (const car of [...state.traffic, ...state.police, ...state.cars]) {
      if (dist(ped.x, ped.y, car.x, car.y) < 80) { tooClose = true; break; }
    }
    if (tooClose) continue;
    state.peds.push(ped);
    added += 1;
  }
  return added;
}

// A moving car close to an intersection: pedestrians wait instead of
// stepping into its path. (Parked cars do not count.)
function carNearNode(state, node) {
  if (!node) return false;
  for (const car of [...(state.traffic || []), ...(state.police || [])]) {
    if (dist(car.x, car.y, node.x, node.y) < 140) return true;
  }
  for (const car of state.cars || []) {
    if (car.isPlayer && Math.abs(car.speed || 0) > 50
      && dist(car.x, car.y, node.x, node.y) < 140) return true;
  }
  return false;
}

// Where the danger is, if any: a gunshot / hard hit (dangerZone), a fast
// player car bearing down, or a patrol car closing in while wanted.
function dangerNear(state, ped) {
  const dz = state.dangerZone;
  if (dz && dz.ttl > 0 && dist(ped.x, ped.y, dz.x, dz.y) < dz.radius + 40) {
    return { x: dz.x, y: dz.y };
  }
  const p = state.player;
  if (p.inCar) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (car && Math.abs(car.speed) > 100 && dist(ped.x, ped.y, car.x, car.y) < 70) {
      return { x: car.x, y: car.y };
    }
  }
  if (state.wanted > 0) {
    for (const cop of state.police) {
      if (dist(ped.x, ped.y, cop.x, cop.y) < 90) return { x: cop.x, y: cop.y };
    }
  }
  return null;
}

// Slide a step, never into a building or the water.
function stepPed(city, ped, nx, ny) {
  const blocked = (x, y) => collidesBuilding(city, x, y, CFG.PED_RADIUS) || isWater(city, x, y);
  if (!blocked(nx, ny)) { ped.x = nx; ped.y = ny; return; }
  // A slide only counts when it actually moves (see vehicles.js).
  if (nx !== ped.x && !blocked(nx, ped.y)) { ped.x = nx; return; }
  if (ny !== ped.y && !blocked(ped.x, ny)) { ped.y = ny; }
}

/**
 * The main.js step-4 entry point. Pedestrians walk their sidewalk edge;
 * at an intersection they may cross to the other sidewalk (the only
 * place crossing happens); they flee from gunfire, hard hits and patrol
 * cars, then find the nearest sidewalk again; they get up after being
 * knocked down (unless a mission guard was killed outright).
 */
export function updatePeds(state, dt) {
  ensureArrays(state);
  if (state.mode !== 'playing') return;
  const city = cityOf(state);
  const nodes = city.roadGraph.nodes;
  spawnPeds(state, CFG.PED_COUNT);

  if (state.dangerZone) {
    state.dangerZone.ttl -= dt;
    if (state.dangerZone.ttl <= 0) state.dangerZone = null;
  }

  for (const raw of state.peds) {
    const ped = ensurePed(raw);
    // Mission guards stand their post; combat.js fights them.
    if (ped.missionGuard) continue;

    // Knocked down: lie still, then get up and run.
    if (ped.down) {
      if (ped.alive === false) continue; // killed outright, stays down
      ped.downTimer -= dt;
      if (ped.downTimer <= 0) {
        ped.down = false;
        ped.state = 'flee';
        ped.fleeTimer = 2.5;
        ped.fleeX = state.player.x;
        ped.fleeY = state.player.y;
      }
      continue;
    }

    // Flee: run away from the danger, then back to the nearest sidewalk.
    if (ped.state === 'flee' || dangerNear(state, ped)) {
      if (ped.state !== 'flee') {
        ped.state = 'flee';
        ped.fleeTimer = 2.5 + rng.next() * 1.5;
        const d = dangerNear(state, ped);
        ped.fleeX = d ? d.x : state.player.x;
        ped.fleeY = d ? d.y : state.player.y;
      }
      ped.fleeTimer -= dt;
      const dx = ped.x - (ped.fleeX ?? ped.x);
      const dy = ped.y - (ped.fleeY ?? ped.y);
      const len = Math.hypot(dx, dy) || 1;
      ped.angle = Math.atan2(dy, dx);
      stepPed(city, ped, ped.x + (dx / len) * FLEE_SPEED * dt, ped.y + (dy / len) * FLEE_SPEED * dt);
      if (ped.fleeTimer <= 0) {
        const edge = edgeFromRoadPoint(city, ped.x, ped.y);
        if (edge) {
          ped.from = edge.from; ped.to = edge.to; ped.t = edge.t; ped.side = edge.side;
          ped.state = 'walk';
        } else {
          ped.fleeTimer = 1; // no road nearby yet: keep running a little
        }
      }
      continue;
    }

    // Standing on the sidewalk: wait a while, then walk on.
    if (ped.state === 'idle-sidewalk') {
      ped.waitTimer -= dt;
      if (ped.waitTimer <= 0) ped.state = 'walk';
      continue;
    }

    // Crossing at an intersection: from one sidewalk to the other.
    if (ped.state === 'cross') {
      ped.crossT += dt / 1.1;
      const a = nodes[ped.from];
      const b = nodes[ped.to];
      if (!a || !b) { ped.state = 'walk'; ped.crossT = 0; continue; }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const perp = perpOf(dx, dy, len);
      const k = clamp(ped.crossT, 0, 1);
      const off = (1 - k) * ped.side * SIDEWALK_OFF + k * -ped.side * SIDEWALK_OFF;
      ped.x = a.x + perp.x * off;
      ped.y = a.y + perp.y * off;
      ped.angle = Math.atan2(perp.y, perp.x);
      if (ped.crossT >= 1) {
        ped.side = -ped.side;
        ped.state = 'walk';
        ped.crossT = 0;
      }
      continue;
    }

    // Walking: advance along the sidewalk edge; at the intersection pick
    // the next edge, and sometimes cross to the other sidewalk first.
    const a = nodes[ped.from];
    const b = nodes[ped.to];
    if (!a || !b || ped.from === ped.to) {
      const edge = edgeFromRoadPoint(city, ped.x, ped.y);
      if (edge) {
        ped.from = edge.from; ped.to = edge.to; ped.t = edge.t; ped.side = edge.side;
      } else {
        ped.t = 0;
      }
      continue;
    }
    const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    ped.t += (ped.speed * dt) / segLen;
    if (ped.t >= 1) {
      const arrived = ped.to;
      const cameFrom = ped.from;
      const options = (city.roadGraph.adj.get(arrived) || []).filter((id) => id !== cameFrom);
      ped.from = arrived;
      if (options.length === 0) {
        ped.to = cameFrom; // no onward edge: turn back along the same edge
      } else {
        ped.to = options[Math.floor(rng.next() * options.length)];
      }
      ped.t = 0;
      if (rng.next() < 0.3 && !carNearNode(state, nodes[arrived])) {
        // Cross here, at the intersection, to the other sidewalk —
        // but only when no car is bearing down on the crossing.
        ped.state = 'cross';
        ped.crossT = 0;
        ped.crossFrom = ped.from;
        ped.crossTo = ped.to;
      }
      continue;
    }
    const pt = edgePoint(a, b, ped.t, ped.side);
    ped.x = pt.x; ped.y = pt.y; ped.angle = pt.angle;
  }

  // Separation: pedestrians keep a little personal space.
  const walkers = state.peds.filter((p) => !p.down && !p.missionGuard);
  for (let i = 0; i < walkers.length; i++) {
    for (let j = i + 1; j < walkers.length; j++) {
      const a = walkers[i];
      const b = walkers[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= 16 || d < 0.01) continue;
      const push = (16 - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
    }
  }

  // Last resort: a car must never sit on top of a pedestrian. Push the
  // pedestrian away from the car until clear (traffic itself already
  // stops for anyone in its path; this only fires if something slipped
  // through, e.g. a pedestrian walking into a car that stopped for them).
  for (const ped of walkers) {
    for (const car of [...state.traffic, ...state.police]) {
      if (dist(ped.x, ped.y, car.x, car.y) >= 26) continue;
      const dx = ped.x - car.x;
      const dy = ped.y - car.y;
      const len = Math.hypot(dx, dy) || 1;
      const tries = [
        { x: dx / len, y: dy / len },
        { x: -dy / len, y: dx / len },
        { x: dy / len, y: -dx / len },
        { x: -dx / len, y: -dy / len },
      ];
      for (const dir of tries) {
        const nx = car.x + dir.x * 32;
        const ny = car.y + dir.y * 32;
        if (!collidesBuilding(city, nx, ny, CFG.PED_RADIUS) && !isWater(city, nx, ny)) {
          ped.x = nx; ped.y = ny;
          break;
        }
      }
      car.speed = 0;
      break;
    }
    const c = clampToWorld(ped.x, ped.y, CFG.PED_RADIUS);
    ped.x = c.x; ped.y = c.y;
  }
}
