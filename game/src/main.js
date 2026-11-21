// main.js — Port Verda boot, state machine and fixed-timestep loop.
// Wiring order every step: input -> player/vehicles -> traffic -> peds
// -> police -> combat -> missions -> camera/clamp -> render + HUD.
// Systems owned by other builders (player, vehicles, traffic, peds,
// police, combat, missions, audio) are loaded as optional modules when
// present; until they land, compact fallbacks below keep the game fully
// playable. Nothing here depends on a module that does not exist yet.
import { CFG } from './config.js';
import { createRng } from './rng.js';
import { buildCity } from './city.js';
import { drawWorld, drawHUD, drawTitle, drawPaused, drawBusted, drawWasted } from './render.js';
import { saveGame, loadGame, hasSave } from './save.js';

const MAX_FRAME = 0.25;
const CAR_COLORS = ['#c0392b', '#2e86c1', '#f1c40f', '#7d3c98', '#16a085', '#e67e22', '#95a5a6', '#2c3e50'];
const CAR_MODELS = ['Sedan', 'Hatch', 'Pickup', 'Van', 'Coupe'];

const params = new URLSearchParams(window.location.search);
const shotParam = params.get('shot'); // title | drive | chase | mission (screenshot staging)
const autoStart = params.get('start') === '1' || params.get('demo') === '1' || !!shotParam;

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const ctx = canvas.getContext('2d');
const city = buildCity(CFG.SEED);

// --- missions (fallback table; missions.js overrides when it lands) -------
const MISSIONS = [
  { id: 'm1', name: 'Paket Dermaga', giver: 'Mira', objective: 'Antar paket ke Dermaga 3', spotId: 'dermaga', reward: 400 },
  { id: 'm2', name: 'Tagihan Pasar', giver: 'Mira', objective: 'Tagih utang di Pasar Ikan', spotId: 'pasar', reward: 550 },
  { id: 'm3', name: 'Gudang 7', giver: 'Mira', objective: 'Ambil kiriman di Gudang 7', spotId: 'gudang', reward: 700 },
  { id: 'm4', name: 'Pesan Menara', giver: 'Mira', objective: 'Antar pesan ke Menara Kembar', spotId: 'menara', reward: 800 },
  { id: 'm5', name: 'Suku Cadang', giver: 'Mira', objective: 'Ambil suku cadang di Bengkel Tua', spotId: 'bengkel', reward: 950 },
  { id: 'm6', name: 'Akhir Harbor Kings', giver: 'Mira', objective: 'Hadapi Harbor Kings di Pintu Pelabuhan', spotId: 'pintu', reward: 1500 },
  { id: 's1', name: 'Antar Bukit', giver: 'Mira', objective: 'Antar paket ke Bukit Perumahan', spotId: 'bukit', reward: 300 },
  { id: 's2', name: 'Laporan Polisi', giver: 'Mira', objective: 'Lapor ke Kantor Polisi', spotId: 'kantor', reward: 250 },
];

// --- state ------------------------------------------------------------------
function createState() {
  return {
    mode: 'title', // title | playing | paused | busted | wasted
    time: 0, // seconds of play; the HUD clock maps it onto a game day
    money: CFG.START_MONEY,
    health: CFG.PLAYER_MAX_HEALTH,
    wanted: 0,
    wantedTimer: 0,
    player: {
      x: city.spawns.player.x, y: city.spawns.player.y,
      angle: -Math.PI / 2, speed: 0, onFoot: true, inCar: false, carId: null,
      invulnerable: 0,
    },
    cars: [],
    traffic: [],
    peds: [],
    police: [],
    missions: { activeId: null, active: null, target: null, done: [], progress: {} },
    camera: { x: 0, y: 0 },
    input: null, // filled below
    muted: false,
    fx: [],
    toast: null,
    city,
  };
}

const state = createState();

// Parked, drivable cars placed on roads from the city spawns.
function spawnParkedCars() {
  state.cars = city.spawns.cars.map((s, i) => ({
    id: `car-${i}`,
    x: s.x, y: s.y, angle: s.angle, speed: 0,
    color: CAR_COLORS[i % CAR_COLORS.length],
    model: CAR_MODELS[i % CAR_MODELS.length],
    isPlayer: false, isPolice: false,
  }));
}

// --- input (built in; keyboard + mouse) -------------------------------------
function createInput() {
  const keys = new Set();
  const pressed = new Set();
  const mouse = { x: 0, y: 0, down: false, clicked: false };
  const input = {
    keys, mouse,
    get up() { return keys.has('KeyW') || keys.has('ArrowUp'); },
    get down() { return keys.has('KeyS') || keys.has('ArrowDown'); },
    get left() { return keys.has('KeyA') || keys.has('ArrowLeft'); },
    get right() { return keys.has('KeyD') || keys.has('ArrowRight'); },
    get boost() { return keys.has('ShiftLeft') || keys.has('ShiftRight'); },
    script: null, // staging override: {up,down,left,right,boost}
    wasPressed(code) { return pressed.has(code); },
    takePressed() { const out = [...pressed]; pressed.clear(); return out; },
    clearPressed() { pressed.clear(); },
  };
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.down = true; mouse.clicked = true;
  });
  window.addEventListener('mouseup', () => { mouse.down = false; });
  return input;
}
state.input = createInput();

// --- optional modules (other builders) --------------------------------------
// Loaded by computed specifier on purpose: these systems are optional and
// the game must run with or without them. Each is used only when it
// loaded and exports the function named in the step() wiring below.
const mods = {};
async function loadOptionalModules() {
  const names = ['player.js', 'vehicles.js', 'traffic.js', 'peds.js', 'police.js', 'combat.js', 'missions.js', 'audio.js'];
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const mod = await import('./' + name);
      return [name.replace('.js', ''), mod];
    } catch {
      return [name.replace('.js', ''), null];
    }
  }));
  for (const [key, mod] of loaded) mods[key] = mod;
  if (mods.audio && typeof mods.audio.createAudio === 'function') {
    try { mods.audioApi = mods.audio.createAudio(state); } catch { mods.audioApi = null; }
  }
}

function playSound(name) {
  if (state.muted || !mods.audioApi) return;
  try {
    if (typeof mods.audioApi.play === 'function') mods.audioApi.play(name);
  } catch { /* sound is never fatal */ }
}

// --- helpers ------------------------------------------------------------------
function toast(text, seconds = 3) {
  state.toast = { text, ttl: seconds };
}

function addWanted(n) {
  state.wanted = Math.min(CFG.WANTED_MAX, state.wanted + n);
  state.wantedTimer = 0;
}

function clampAllPositions() {
  // Collision resolution (traffic, police rams) pushes entities sideways
  // and can shove one a few pixels into a building's margin — past the
  // point where its own movement check lets it drive or walk out again,
  // so it wedges there forever, speed bouncing off the wall. Police rams
  // can also push a car into the harbour water, where nothing can move
  // at all. Snap anything overlapping a building or in the water back
  // onto the nearest road: roads are always clear, so nothing can stay
  // wedged or drowning.
  const unstick = (e, r) => {
    if (!city.isWater(e.x, e.y) && !city.collidesBuilding(e.x, e.y, r)) return;
    const pt = city.nearestRoad(e.x, e.y);
    if (pt) { e.x = pt.x; e.y = pt.y; }
  };
  // Cars are long, not points: a car turning at an intersection can graze
  // a building corner with its nose while its centre stays on the road.
  // Then every forward step is blocked (the nose is in the wall), the
  // speed bounces to ~0, and the car spins in place forever — the
  // centre-only check above never fires. Check nose and tail too, with
  // the same geometry moveWithCollision uses (r 12, half-length 18).
  const unstickCar = (car) => {
    const blocked = (x, y, r) => city.isWater(x, y) || city.collidesBuilding(x, y, r);
    if (!blocked(car.x, car.y, 24)) {
      const fx = Math.cos(car.angle || 0), fy = Math.sin(car.angle || 0);
      if (!blocked(car.x + fx * 18, car.y + fy * 18, 12)
        && !blocked(car.x - fx * 18, car.y - fy * 18, 12)) return;
    }
    const pt = city.nearestRoad(car.x, car.y);
    if (pt) { car.x = pt.x; car.y = pt.y; }
  };
  const p = state.player;
  const c = city.clampToWorld(p.x, p.y, CFG.PLAYER_RADIUS);
  p.x = c.x; p.y = c.y;
  unstick(p, CFG.PLAYER_RADIUS);
  for (const list of [state.cars, state.traffic, state.police]) {
    for (const car of list) {
      const cc = city.clampToWorld(car.x, car.y, 24);
      car.x = cc.x; car.y = cc.y;
      unstickCar(car);
    }
  }
  for (const ped of state.peds) {
    const cc = city.clampToWorld(ped.x, ped.y, CFG.PED_RADIUS);
    ped.x = cc.x; ped.y = cc.y;
    unstick(ped, CFG.PED_RADIUS);
  }
}

function nearestCar(x, y, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const car of state.cars) {
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestD) { best = car; bestD = d; }
  }
  return best;
}

function moveWithCollision(e, dx, dy, r) {
  const nx = e.x + dx;
  if (!city.collidesBuilding(nx, e.y, r) && !city.isWater(nx, e.y)) e.x = nx;
  const ny = e.y + dy;
  if (!city.collidesBuilding(e.x, ny, r) && !city.isWater(e.x, ny)) e.y = ny;
}

// --- fallback: player on foot + driving ---------------------------------------
let punchCooldown = 0;
let shootCooldown = 0;

function fallbackPlayer(dt) {
  const p = state.player;
  const inp = state.input.script || state.input;

  if (p.inCar) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (!car) { p.inCar = false; p.onFoot = true; p.carId = null; return; }
    const maxSpeed = CFG.CAR_MAX_SPEED * (inp.boost ? CFG.CAR_BOOST_MULT : 1);
    if (inp.up) car.speed += CFG.CAR_ACCEL * (inp.boost ? CFG.CAR_BOOST_MULT : 1) * dt;
    else if (inp.down) {
      car.speed -= (car.speed > 0 ? CFG.CAR_BRAKE : CFG.CAR_REVERSE_ACCEL) * dt;
    } else {
      car.speed *= Math.exp(-CFG.CAR_DRAG * dt);
      if (Math.abs(car.speed) < 4) car.speed = 0;
    }
    car.speed = Math.min(Math.max(car.speed, -CFG.CAR_MAX_REVERSE), maxSpeed);
    const steer = (inp.left ? -1 : 0) + (inp.right ? 1 : 0);
    const dir = car.speed >= 0 ? 1 : -1;
    car.angle += steer * CFG.CAR_TURN * Math.min(1, Math.abs(car.speed) / 160) * dir * dt;
    const nx = car.x + Math.cos(car.angle) * car.speed * dt;
    const ny = car.y + Math.sin(car.angle) * car.speed * dt;
    if (!city.collidesBuilding(nx, ny, 20) && !city.isWater(nx, ny)) { car.x = nx; car.y = ny; }
    else { car.speed *= -0.25; }
    p.x = car.x; p.y = car.y; p.angle = car.angle; p.speed = car.speed;
    return;
  }

  // On foot.
  let mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  let my = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
  if (mx !== 0 || my !== 0) {
    const len = Math.hypot(mx, my);
    mx /= len; my /= len;
    p.angle = Math.atan2(my, mx);
    p.speed = CFG.WALK_SPEED;
    moveWithCollision(p, mx * p.speed * dt, my * p.speed * dt, CFG.PLAYER_RADIUS);
  } else {
    p.speed = 0;
  }
}

function fallbackEnterExit() {
  const p = state.player;
  if (p.inCar) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (car) {
      car.isPlayer = false;
      car.speed = 0;
      const side = car.angle + Math.PI / 2;
      let ex = car.x + Math.cos(side) * 34;
      let ey = car.y + Math.sin(side) * 34;
      if (city.collidesBuilding(ex, ey, CFG.PLAYER_RADIUS) || city.isWater(ex, ey)) {
        ex = car.x - Math.cos(side) * 34;
        ey = car.y - Math.sin(side) * 34;
      }
      p.x = ex; p.y = ey;
    }
    p.inCar = false; p.onFoot = true; p.carId = null;
    toast('Keluar mobil');
  } else {
    const car = nearestCar(p.x, p.y, CFG.CAR_ENTER_DIST);
    if (car) {
      car.isPlayer = true;
      p.inCar = true; p.onFoot = false; p.carId = car.id;
      p.x = car.x; p.y = car.y; p.angle = car.angle;
      toast(`Masuk ${car.model} — W gas, S rem, Shift boost`);
    }
  }
}

// --- fallback: combat (punch + shoot) -----------------------------------------
function fallbackCombat() {
  const p = state.player;
  const inp = state.input;
  if (inp.wasPressed('KeyF') && punchCooldown <= 0) {
    punchCooldown = CFG.PUNCH_COOLDOWN;
    let hit = null;
    let bestD = CFG.PUNCH_RANGE + 20;
    for (const ped of state.peds) {
      if (ped.down) continue;
      const d = Math.hypot(ped.x - p.x, ped.y - p.y);
      if (d < bestD) { hit = ped; bestD = d; }
    }
    state.fx.push({ kind: 'punch', x: p.x + Math.cos(p.angle) * 22, y: p.y + Math.sin(p.angle) * 22, ttl: 0.18, max: 0.18 });
    if (hit) {
      hit.down = true;
      addWanted(CFG.CRIME_HEAT_PUNCH);
      toast('Kamu memukul pejalan kaki! Polisi waspada.');
      playSound('punch');
    }
  }
  if (inp.mouse.clicked && shootCooldown <= 0) {
    inp.mouse.clicked = false;
    shootCooldown = CFG.SHOOT_COOLDOWN;
    const wx = inp.mouse.x + state.camera.x;
    const wy = inp.mouse.y + state.camera.y;
    const aim = Math.atan2(wy - p.y, wx - p.x);
    let hit = null;
    let bestD = CFG.SHOOT_RANGE;
    for (const ped of state.peds) {
      if (ped.down) continue;
      const d = Math.hypot(ped.x - p.x, ped.y - p.y);
      if (d > CFG.SHOOT_RANGE) continue;
      const a = Math.atan2(ped.y - p.y, ped.x - p.x);
      let diff = Math.abs(a - aim);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < 0.3 && d < bestD) { hit = ped; bestD = d; }
    }
    const tx = hit ? hit.x : p.x + Math.cos(aim) * CFG.SHOOT_RANGE;
    const ty = hit ? hit.y : p.y + Math.sin(aim) * CFG.SHOOT_RANGE;
    state.fx.push({ kind: 'tracer', x1: p.x, y1: p.y, x2: tx, y2: ty, ttl: 0.12, max: 0.12 });
    if (hit) {
      hit.down = true;
      addWanted(CFG.CRIME_HEAT_SHOOT);
      toast('Tembakan! Wanted naik.');
    }
    playSound('shoot');
  } else {
    inp.mouse.clicked = false;
  }
}

// --- fallback: traffic ---------------------------------------------------------
const rng = createRng(CFG.SEED + 7);

// Cars follow road segments node-to-node (never free steering), so they
// stay exactly on the asphalt and turn crisply at intersections.
function segLen(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function segPos(a, b, s, len) {
  const t = len > 0 ? Math.min(1, s / len) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function turnToward(angle, want, rate, dt) {
  let diff = want - angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return angle + Math.max(-rate * dt, Math.min(rate * dt, diff));
}

function spawnTrafficCar() {
  const from = city.roadGraph.nodes[rng.randInt(0, city.roadGraph.nodes.length - 1)];
  const options = city.roadGraph.adj.get(from.id);
  const to = city.roadGraph.nodes[rng.pick(options)];
  return {
    id: `traffic-${Math.floor(rng.next() * 1e9)}`,
    x: from.x, y: from.y, angle: Math.atan2(to.y - from.y, to.x - from.x), speed: CFG.TRAFFIC_SPEED,
    color: rng.pick(CAR_COLORS), model: rng.pick(CAR_MODELS),
    isPlayer: false, isPolice: false,
    from: from.id, to: to.id, s: 0,
  };
}

function fallbackTraffic(dt) {
  while (state.traffic.length < CFG.TRAFFIC_COUNT) state.traffic.push(spawnTrafficCar());
  for (const car of state.traffic) {
    let a = city.roadGraph.nodes[car.from];
    let b = city.roadGraph.nodes[car.to];
    let len = segLen(a, b);
    car.s += car.speed * dt;
    while (car.s >= len) {
      car.s -= len;
      car.from = car.to;
      const options = city.roadGraph.adj.get(car.to).filter((id) => id !== car.from);
      car.to = options.length ? rng.pick(options) : car.from;
      a = city.roadGraph.nodes[car.from];
      b = city.roadGraph.nodes[car.to];
      len = segLen(a, b);
      if (len === 0) break;
    }
    const pos = segPos(a, b, car.s, len);
    car.x = pos.x;
    car.y = pos.y;
    car.angle = turnToward(car.angle, Math.atan2(b.y - a.y, b.x - a.x), 10, dt);
  }
}

// --- fallback: pedestrians ------------------------------------------------------
function spawnPed() {
  const a = city.roadGraph.nodes[rng.randInt(0, city.roadGraph.nodes.length - 1)];
  const options = city.roadGraph.adj.get(a.id);
  const b = city.roadGraph.nodes[rng.pick(options)];
  return {
    x: a.x, y: a.y, angle: Math.atan2(b.y - a.y, b.x - a.x),
    speed: CFG.PED_SPEED * rng.rand(0.8, 1.2),
    color: rng.pick(['#e8dcc0', '#7fb069', '#c17a9e', '#e0a458', '#8ecae6', '#f4f1de']),
    down: false, from: a.id, to: b.id, t: 0, side: rng.chance(0.5) ? 1 : -1,
  };
}

function fallbackPeds(dt) {
  while (state.peds.length < CFG.PED_COUNT) state.peds.push(spawnPed());
  for (const ped of state.peds) {
    if (ped.down) continue;
    const a = city.roadGraph.nodes[ped.from];
    const b = city.roadGraph.nodes[ped.to];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    ped.t += (ped.speed * dt) / Math.max(1, segLen);
    if (ped.t >= 1) {
      ped.from = ped.to;
      const options = city.roadGraph.adj.get(ped.to).filter((id) => id !== ped.from);
      ped.to = options.length ? rng.pick(options) : ped.from;
      ped.t = 0;
      if (rng.chance(0.25)) ped.side *= -1;
      continue;
    }
    const nx = a.x + (b.x - a.x) * ped.t;
    const ny = a.y + (b.y - a.y) * ped.t;
    const px = -(b.y - a.y) / segLen;
    const py = (b.x - a.x) / segLen;
    const off = (CFG.ROAD_W / 2 + CFG.SIDEWALK / 2) * ped.side;
    ped.x = nx + px * off;
    ped.y = ny + py * off;
    ped.angle = Math.atan2(b.y - a.y, b.x - a.x);
  }
}

// --- fallback: police -----------------------------------------------------------
// Police chase along the road graph (BFS path to the player's nearest
// intersection), never cutting across blocks; only at close range do they
// steer straight at the player. A road snap after every move keeps them
// on the asphalt even while turning.
function nearestNodeId(x, y) {
  let best = 0;
  let bestD = Infinity;
  for (const n of city.roadGraph.nodes) {
    const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

function bfsPath(fromId, toId) {
  if (fromId === toId) return [toId];
  const prev = new Map([[fromId, -1]]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    for (const nb of city.roadGraph.adj.get(id)) {
      if (prev.has(nb)) continue;
      prev.set(nb, id);
      if (nb === toId) {
        const path = [toId];
        let cur = toId;
        while (prev.get(cur) !== -1) { cur = prev.get(cur); path.unshift(cur); }
        return path;
      }
      queue.push(nb);
    }
  }
  return [toId];
}

function fallbackPolice(dt) {
  const want = Math.min(state.wanted, 3);
  while (state.police.length < want) {
    let pt = null;
    for (let tries = 0; tries < 8; tries++) {
      const cand = city.randomRoadPoint(rng);
      if (Math.hypot(cand.x - state.player.x, cand.y - state.player.y) > CFG.POLICE_SPAWN_DIST) { pt = cand; break; }
    }
    if (!pt) pt = city.randomRoadPoint(rng);
    const node = nearestNodeId(pt.x, pt.y);
    state.police.push({
      id: `police-${Math.floor(rng.next() * 1e9)}`,
      x: pt.x, y: pt.y, angle: pt.angle, speed: 0,
      color: '#20242a', model: 'Patrol', isPlayer: false, isPolice: true, lastRam: 0,
      node, next: node, s: 0, path: [], repath: 0,
    });
  }
  while (state.police.length > want) state.police.pop();

  for (const car of state.police) {
    car.lastRam = Math.max(0, car.lastRam - dt);
    car.repath = Math.max(0, car.repath - dt);
    const p = state.player;
    const playerNode = nearestNodeId(p.x, p.y);

    // Re-path once a second from the node being driven to (no teleports).
    if (car.repath <= 0) {
      const full = bfsPath(car.next, playerNode);
      car.path = full.slice(1);
      car.repath = 1;
    }

    // Advance along the current segment; hop to the next path node at its end.
    let a = city.roadGraph.nodes[car.node];
    let b = city.roadGraph.nodes[car.next];
    let len = segLen(a, b);
    car.speed = Math.min(CFG.POLICE_CHASE_SPEED, car.speed + 300 * dt);
    car.s += car.speed * dt;
    let guard = 0;
    while (len > 0 && car.s >= len && guard < 8) {
      guard++;
      car.s -= len;
      car.node = car.next;
      if (car.path.length > 0) car.next = car.path.shift();
      else {
        const full = bfsPath(car.node, playerNode);
        car.path = full.slice(1);
        car.next = car.path.length > 0 ? car.path.shift() : car.node;
      }
      a = city.roadGraph.nodes[car.node];
      b = city.roadGraph.nodes[car.next];
      len = segLen(a, b);
    }
    if (len === 0) {
      // Parked at the player's intersection: wait for them to move.
      car.s = 0;
      car.speed = Math.min(car.speed, 120);
    }
    const pos = segPos(a, b, car.s, len);
    car.x = pos.x;
    car.y = pos.y;
    if (len > 0) car.angle = turnToward(car.angle, Math.atan2(b.y - a.y, b.x - a.x), 10, dt);

    const dist = Math.hypot(p.x - car.x, p.y - car.y);
    if (dist < CFG.POLICE_BUST_DIST && p.onFoot && p.invulnerable <= 0) {
      state.mode = 'busted';
      saveGame(state);
      playSound('busted');
      return;
    }
    if (dist < 52 && p.inCar && car.lastRam <= 0) {
      car.lastRam = 1;
      state.health -= CFG.POLICE_RAM_DAMAGE;
      p.invulnerable = 1;
      toast('Polisi menabrak mobilmu!');
      playSound('hit');
      if (state.health <= 0) {
        state.health = 0;
        state.mode = 'wasted';
        saveGame(state);
      }
    }
  }
}

// --- fallback: missions -----------------------------------------------------------
function startMission(id) {
  if (mods.missions && typeof mods.missions.startMission === 'function') {
    mods.missions.startMission(state, id);
    return;
  }
  const def = MISSIONS.find((m) => m.id === id);
  if (!def) return;
  const spot = city.spawns.missionSpots.find((s) => s.id === def.spotId);
  if (!spot) return;
  state.missions.activeId = def.id;
  state.missions.active = def;
  state.missions.target = { x: spot.x, y: spot.y };
  toast(`${def.name} — ${def.objective}`);
}

function fallbackMissions() {
  const m = state.missions.active;
  if (!m || !state.missions.target) return;
  const d = Math.hypot(state.player.x - state.missions.target.x, state.player.y - state.missions.target.y);
  if (d < CFG.MISSION_ARRIVE_DIST) {
    state.money += m.reward;
    state.missions.done.push(m.id);
    state.missions.activeId = null;
    state.missions.active = null;
    state.missions.target = null;
    state.wanted = Math.max(0, state.wanted - 1);
    toast(`Misi selesai! +$${m.reward}. Tekan N untuk misi berikutnya.`);
    playSound('mission');
    saveGame(state);
  }
}

function nextMission() {
  const next = MISSIONS.find((m) => !state.missions.done.includes(m.id));
  if (next) startMission(next.id);
  else toast('Semua misi selesai! Port Verda milikmu, Raka.');
}

// --- game flow ------------------------------------------------------------------
function newGame() {
  const fresh = createState();
  Object.assign(state, fresh, { input: state.input, city });
  spawnParkedCars();
  state.mode = 'playing';
  startMission('m1');
  announce('Bermain. Misi pertama: Paket Dermaga.');
}

function continueSave() {
  const data = loadGame();
  if (!data) return false;
  const fresh = createState();
  Object.assign(state, fresh, { input: state.input, city });
  spawnParkedCars();
  // Wasted saves are poisoned as they stand: health 0 resumes straight
  // into 'wasted' again, so Continue is a dead button. A wasted Raka
  // wakes up at the hospital instead — half health, wanted cleared,
  // same money and finished missions.
  if ((data.health ?? 100) <= 0) {
    const hospital = city.spawns.hospital || { x: 680, y: 1100 };
    state.player.x = hospital.x;
    state.player.y = hospital.y;
    state.health = Math.floor(CFG.PLAYER_MAX_HEALTH / 2);
    state.wanted = 0;
    state.wantedTimer = 0;
    announce('Raka siuman di rumah sakit. Setengah sehat, polisi sudah pergi.');
  } else {
    state.player.x = data.x;
    state.player.y = data.y;
    state.health = data.health;
    state.wanted = data.wanted;
  }
  // A bust can save the player where a ram pushed them — in the water or
  // inside a building's margin. Never resume standing in either: snap
  // onto the nearest road before play resumes.
  if (city.isWater(state.player.x, state.player.y)
    || city.collidesBuilding(state.player.x, state.player.y, CFG.PLAYER_RADIUS)) {
    const pt = city.nearestRoad(state.player.x, state.player.y);
    if (pt) { state.player.x = pt.x; state.player.y = pt.y; }
  }
  state.money = data.money;
  state.time = data.time;
  state.missions.done = data.missionsDone;
  state.mode = 'playing';
  if (data.activeMission) startMission(data.activeMission);
  else if (state.missions.done.length < MISSIONS.length) nextMission();
  announce('Save dilanjutkan.');
  return true;
}

function announce(message) {
  statusEl.textContent = message;
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Prefer the owning module when it exists; otherwise the fallback above.
function stepTraffic(dt) {
  if (mods.traffic && typeof mods.traffic.updateTraffic === 'function') mods.traffic.updateTraffic(state, dt);
  else fallbackTraffic(dt);
}

function stepPeds(dt) {
  if (mods.peds && typeof mods.peds.updatePeds === 'function') mods.peds.updatePeds(state, dt);
  else fallbackPeds(dt);
}

// --- the fixed step ---------------------------------------------------------------
function step(dt) {
  const inp = state.input;
  if (state.mode !== 'playing') {
    inp.clearPressed();
    inp.mouse.clicked = false;
    return;
  }

  // 1. input edge actions
  const pressed = inp.takePressed();
  if (pressed.includes('KeyE')) fallbackEnterExit();
  if (pressed.includes('KeyN')) nextMission();
  if (pressed.includes('KeyP')) {
    state.mode = 'paused';
    saveGame(state);
    announce('Jeda. Permainan disimpan.');
    return;
  }
  if (pressed.includes('KeyM')) {
    state.muted = !state.muted;
    toast(state.muted ? 'Suara mati' : 'Suara hidup');
    if (mods.audioApi && typeof mods.audioApi.setMuted === 'function') mods.audioApi.setMuted(state.muted);
  }

  // 2. player / vehicles
  // Cooldowns decay here — not inside fallbackPlayer — so they also tick
  // when the wired player module (player.js, B2 driving) runs instead of
  // the fallback. Otherwise the first punch would leave F dead forever
  // and the first hit would leave Raka invulnerable forever.
  state.player.invulnerable = Math.max(0, state.player.invulnerable - dt);
  punchCooldown = Math.max(0, punchCooldown - dt);
  shootCooldown = Math.max(0, shootCooldown - dt);
  if (mods.player && typeof mods.player.updatePlayer === 'function') mods.player.updatePlayer(state, dt, inp);
  else fallbackPlayer(dt);
  if (mods.vehicles && typeof mods.vehicles.updateVehicles === 'function') mods.vehicles.updateVehicles(state, dt, inp);

  // 3. traffic
  stepTraffic(dt);

  // 4. pedestrians
  stepPeds(dt);

  // 5. police
  if (mods.police && typeof mods.police.updatePolice === 'function') mods.police.updatePolice(state, dt);
  else fallbackPolice(dt);
  if (state.mode !== 'playing') return; // busted / wasted inside police step

  // 6. combat
  if (mods.combat && typeof mods.combat.updateCombat === 'function') mods.combat.updateCombat(state, dt, inp);
  else fallbackCombat();

  // 7. missions
  if (mods.missions && typeof mods.missions.updateMissions === 'function') mods.missions.updateMissions(state, dt);
  else fallbackMissions();

  // 7b. audio: engine hum + siren follow the live state every frame.
  // updateAudio no-ops until the AudioContext exists, so this is safe
  // before the first user gesture; initAudio runs from Enter (below).
  if (mods.audio && typeof mods.audio.updateAudio === 'function') {
    try { mods.audio.updateAudio(state); } catch { /* sound never breaks the game */ }
  }

  // Clock, wanted decay, health regen, effects, camera.
  state.time += dt;
  if (state.wanted > 0) {
    state.wantedTimer += dt;
    if (state.wantedTimer >= CFG.WANTED_DECAY_SECONDS) {
      state.wanted -= 1;
      state.wantedTimer = 0;
      if (state.wanted === 0) toast('Polisi kehilangan jejakmu.');
    }
  }
  if (state.wanted === 0 && state.health < CFG.PLAYER_MAX_HEALTH) {
    state.health = Math.min(CFG.PLAYER_MAX_HEALTH, state.health + 2 * dt);
  }
  for (let i = state.fx.length - 1; i >= 0; i--) {
    state.fx[i].ttl -= dt;
    if (state.fx[i].ttl <= 0) state.fx.splice(i, 1);
  }
  if (state.toast) {
    state.toast.ttl -= dt;
    if (state.toast.ttl <= 0) state.toast = null;
  }
  const viewW = canvas.width;
  const viewH = canvas.height;
  const tx = Math.min(Math.max(state.player.x - viewW / 2, 0), Math.max(0, CFG.WORLD_W - viewW));
  const ty = Math.min(Math.max(state.player.y - viewH / 2, 0), Math.max(0, CFG.WORLD_H - viewH));
  state.camera.x += (tx - state.camera.x) * Math.min(1, CFG.CAMERA_LERP * dt);
  state.camera.y += (ty - state.camera.y) * Math.min(1, CFG.CAMERA_LERP * dt);

  // 8. nothing may ever leave the world.
  clampAllPositions();
}

// --- rendering ----------------------------------------------------------------------
function render() {
  if (state.mode === 'title') {
    drawWorld(ctx, state.camera, state);
    drawHUD(ctx, state);
    drawTitle(ctx, state, hasSave());
    return;
  }
  drawWorld(ctx, state.camera, state);
  drawHUD(ctx, state);
  if (state.mode === 'paused') drawPaused(ctx);
  else if (state.mode === 'busted') drawBusted(ctx);
  else if (state.mode === 'wasted') drawWasted(ctx);
}

// --- screenshot staging (?shot=title|drive|chase|mission) ---------------------------
function stageShot(kind) {
  newGame();
  if (kind === 'title') {
    state.mode = 'title';
    return;
  }
  if (kind === 'drive' || kind === 'chase' || kind === 'mission') {
    state.player.x = 1200;
    state.player.y = 860;
    const car = state.cars[0];
    if (car) {
      car.x = 1200; car.y = 860; car.angle = 0; car.isPlayer = true;
      state.player.inCar = true; state.player.onFoot = false; state.player.carId = car.id;
    }
    state.input.script = { up: true, down: false, left: false, right: false, boost: false };
    if (kind === 'chase') {
      addWanted(3);
      state.input.script = { up: true, down: false, left: false, right: false, boost: true };
    }
    if (kind === 'mission') {
      startMission('m1');
      state.player.x = 420; state.player.y = 1500;
      if (car) { car.x = 420; car.y = 1500; }
    }
    const steps = kind === 'mission' ? 40 : 150;
    for (let i = 0; i < steps; i++) step(CFG.FIXED_DT);
    state.input.script = null;
    state.camera.x = Math.min(Math.max(state.player.x - canvas.width / 2, 0), Math.max(0, CFG.WORLD_W - canvas.width));
    state.camera.y = Math.min(Math.max(state.player.y - canvas.height / 2, 0), Math.max(0, CFG.WORLD_H - canvas.height));
  }
}

// --- main loop ------------------------------------------------------------------------
let accumulator = 0;
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  accumulator += Math.min((now - last) / 1000, MAX_FRAME);
  last = now;

  // Title / end-screen keys (edge-triggered, handled outside the sim step).
  // When playing, do NOT takePressed() here: step() consumes the edges
  // (E enter/exit, F punch, P pause, M mute, N next mission, click shoot).
  // An earlier version took them here first, so step() never saw any of
  // them — E/F/P/M/N and click-to-shoot were all dead during gameplay
  // (the car could be driven, but nobody could ever get out of it).
  if (state.mode !== 'playing') {
    const pressed = state.input.takePressed();
    if (state.mode === 'title') {
      if (pressed.includes('Enter') || state.input.mouse.clicked) {
        state.input.mouse.clicked = false;
        // First user gesture: start audio (engine hum + siren) here.
        if (mods.audio && typeof mods.audio.initAudio === 'function') {
          try { mods.audio.initAudio(); } catch { /* sound never breaks the game */ }
        }
        newGame();
      } else if (pressed.includes('KeyL') && hasSave()) {
        continueSave();
      }
    } else if (state.mode === 'busted' || state.mode === 'wasted') {
      if (pressed.includes('Enter')) newGame();
    } else if (state.mode === 'paused') {
      if (pressed.includes('KeyP') || pressed.includes('Enter')) {
        state.mode = 'playing';
        announce('Bermain.');
      } else if (pressed.includes('KeyR')) {
        newGame();
      }
    }
    state.input.mouse.clicked = false;
  }

  if (state.mode === 'playing') {
    while (accumulator >= CFG.FIXED_DT && state.mode === 'playing') {
      step(CFG.FIXED_DT);
      accumulator -= CFG.FIXED_DT;
    }
  } else {
    accumulator = 0;
    // The title screen still shows a living city behind the panel.
    if (state.mode === 'title') {
      state.time += CFG.FIXED_DT;
      stepTraffic(CFG.FIXED_DT);
      stepPeds(CFG.FIXED_DT);
    }
  }
  render();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'playing') {
    state.mode = 'paused';
    saveGame(state);
    announce('Jeda. Permainan disimpan.');
  }
});

// --- debug / play-test API ---------------------------------------------------------------
window.__portVerda = {
  state,
  city,
  startMission,
  teleport(x, y) {
    const c = city.clampToWorld(x, y, CFG.PLAYER_RADIUS);
    state.player.x = c.x;
    state.player.y = c.y;
    if (state.player.inCar) {
      const car = state.cars.find((cc) => cc.id === state.player.carId);
      if (car) { car.x = c.x; car.y = c.y; }
    }
    state.camera.x = Math.min(Math.max(c.x - canvas.width / 2, 0), Math.max(0, CFG.WORLD_W - canvas.width));
    state.camera.y = Math.min(Math.max(c.y - canvas.height / 2, 0), Math.max(0, CFG.WORLD_H - canvas.height));
  },
  setWanted(n) { state.wanted = Math.min(Math.max(n, 0), CFG.WANTED_MAX); state.wantedTimer = 0; },
  giveCar() {
    const pt = city.nearestRoad(state.player.x, state.player.y);
    const car = {
      id: `car-gift-${Date.now()}`,
      x: pt.x, y: pt.y, angle: pt.angle, speed: 0,
      color: '#c0392b', model: 'Sedan', isPlayer: true, isPolice: false,
    };
    state.cars.push(car);
    state.player.inCar = true;
    state.player.onFoot = false;
    state.player.carId = car.id;
    state.player.x = car.x;
    state.player.y = car.y;
  },
  save: () => saveGame(state),
  load: () => continueSave(),
  audioStatus() {
    try {
      return {
        hasApi: !!mods.audioApi,
        ready: !!(mods.audio && typeof mods.audio.isAudioReady === 'function' && mods.audio.isAudioReady()),
      };
    } catch { return { hasApi: false, ready: false }; }
  },
};

// --- boot ----------------------------------------------------------------------------------
spawnParkedCars();
loadOptionalModules().then(() => {
  if (shotParam) {
    stageShot(shotParam);
    render();
    render();
    window.__shotReady = true;
    return;
  }
  if (params.get('demo') === '1') {
    newGame();
    window.__portVerda.giveCar();
    window.__portVerda.setWanted(2);
  } else if (autoStart) {
    newGame();
  }
  announce('Port Verda. Tekan Enter untuk mulai.');
  requestAnimationFrame(frame);
});
