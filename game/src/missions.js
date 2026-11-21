// missions.js — Port Verda story missions + side jobs (Builder B3).
//
// Written from scratch in this session. No library, no network, no external asset.
// Pure game logic: no DOM, no canvas, no AudioContext here, so it can be unit-tested
// in plain Node. The only side effects are writes onto the shared `state` object.
//
// STATE CONTRACT (agreed with B1/B2; aligned to B1's config.js / city.js /
// render.js / save.js as committed in this repo):
//   state = { mode, time, money, health, wanted, player:{x,y,angle,speed,onFoot,inCar,carId},
//             cars:[], traffic:[], peds:[], police:[], fx:[], toast:{text,ttl}|null,
//             city, missions:{activeId, active, target, done:[], progress:{}},
//             camera:{x,y}, input, muted }
//   state.time is elapsed minutes since 08:00 (render.js clock: 08:00 + state.time).
//   state.camera is the TOP-LEFT corner of the viewport (render.js drawWorld
//   translates by -cam.x/-cam.y). state.city is buildCity() from city.js.
//   state.missions.activeId is the running mission (save.js stores it);
//   state.missions.active = {id, name, objective} and state.missions.target =
//   {x, y, label} are the fields render.js reads every frame — this module
//   keeps them in sync, so the minimap blip, world beacon and top-centre
//   mission banner always show the live objective.
//
// WORLD CONTRACT (B1 city.js): world 2560 x 1920. Avenues x in
// [160,420,680,940,1200,1460,1720,1980,2240]; streets y in
// [140,380,620,860,1100,1340,1560]; promenade y=1680; water y>=1740.
// Districts (city.js districtAt): oldtown x<940,y<860; downtown x 940-1720,
// y<1340 (and market x>=1720,y<860); industrial x<940,y 860-1340;
// hills x>=1720,y 860-1340; harbor y>=1340.
// Key spots come from city.spawns.missionSpots when state.city exists
// (B1's data wins); LOCATIONS below are the same points as defaults, so the
// missions also work in Node tests without a city.
//
// Mission flow: story missions run in order m1 -> m6. Side jobs (taxi, courier)
// can be taken any time no story/side mission is active, and are repeatable.
// Every mission is playable end to end through real gameplay: reach a marker,
// carry a package, keep wanted low, evade police, steal and deliver a car,
// defeat guards, ram a fleeing truck. Completion/failure is checked every frame
// by updateMissions(state, dt); it returns an event object when something
// resolves, or null. main.js should play the matching jingle (audio.js) on it.

import { CFG } from './config.js';

export const WORLD = { width: 2560, height: 1920 };

export const DISTRICTS = {
  oldtown:    { x: 0,    y: 0,    w: 940,  h: 860,  label: 'Old Town' },
  downtown:   { x: 940,  y: 0,    w: 780,  h: 1340, label: 'Downtown' },
  market:     { x: 1720, y: 0,    w: 840,  h: 860,  label: 'Market' },
  industrial: { x: 0,    y: 860,  w: 940,  h: 480,  label: 'Industrial' },
  hills:      { x: 1720, y: 860,  w: 840,  h: 480,  label: 'Hills' },
  harbor:     { x: 0,    y: 1340, w: 2560, h: 580,  label: 'Harbor' },
};

// Default key locations (world px), all on or next to a road in the right
// district. Overridden by state.city.spawns.missionSpots when present.
export const LOCATIONS = {
  dockPickup:    { x: 320,  y: 1700, district: 'harbor',     label: 'Dermaga 3' },
  miraBase:      { x: 560,  y: 1680, district: 'harbor',     label: 'Markas Mira' },
  marketShop:    { x: 1980, y: 620,  district: 'market',     label: 'Pasar Ikan' },
  industrialDrop:{ x: 420,  y: 1100, district: 'industrial', label: 'Gudang Industrial' },
  downtownSport: { x: 1200, y: 380,  district: 'downtown',   label: 'Menara Kembar' },
  industrialGarage: { x: 680,  y: 1100, district: 'industrial', label: 'Bengkel Tua' },
  warehouse:     { x: 420,  y: 1560, district: 'harbor',     label: 'Gudang 7' },
  truckStart:    { x: 320,  y: 1700, district: 'harbor',     label: 'Dermaga 3' },
  hillsExit:     { x: 2540, y: 1100, district: 'hills',      label: 'Pintu Keluar Hills' },
  taxiStandA:    { x: 1980, y: 620,  district: 'market',     label: 'Pasar Ikan' },
  taxiStandB:    { x: 1200, y: 380,  district: 'downtown',   label: 'Menara Kembar' },
  taxiStandC:    { x: 680,  y: 1100, district: 'industrial', label: 'Bengkel Tua' },
  taxiStandD:    { x: 2240, y: 1100, district: 'hills',      label: 'Bukit Perumahan' },
};

// Which B1 missionSpots id each location maps to (city.js spawns).
const SPOT_IDS = {
  dockPickup: 'dermaga',
  marketShop: 'pasar',
  warehouse: 'gudang',
  downtownSport: 'menara',
  industrialGarage: 'bengkel',
  truckStart: 'dermaga',
  taxiStandA: 'pasar',
  taxiStandB: 'menara',
  taxiStandC: 'bengkel',
  taxiStandD: 'bukit',
};

const REACH = (CFG && CFG.MISSION_ARRIVE_DIST) || 64; // px: arrive radius (B1 CFG)
const RAM_DIST = 84;       // px: player/truck contact counts as a ram
const RAM_DAMAGE = 34;     // truck hp lost per ram (= B2 SHOOT_DAMAGE scale)
const RAM_COOLDOWN = 0.5;  // s between ram hits
const TRUCK_SPEED = 250;   // px/s fleeing truck
const TRUCK_HP = 100;
const GUARD_COUNT = 5;
const GUARD_HP = 100;
const ESCAPE_DIST = 1200;  // px: truck escapes if player this far for too long
const ESCAPE_TIME = 8;     // s beyond ESCAPE_DIST before the truck escapes
const COURIER_TIME = 75;   // s for a courier delivery
const TAXI_FAST_TIME = 45; // s: taxi bonus threshold

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Resolve a named location, preferring B1's city data on state when present. */
export function getLocation(state, key) {
  const def = LOCATIONS[key];
  if (!def) return null;
  const city = state && state.city;
  if (city && city.spawns && Array.isArray(city.spawns.missionSpots)) {
    const spotId = SPOT_IDS[key];
    if (spotId) {
      const spot = city.spawns.missionSpots.find((s) => s && s.id === spotId);
      if (spot) return { x: spot.x, y: spot.y, district: def.district, label: spot.name || def.label };
    }
  }
  if (city && city.locations && city.locations[key]) {
    const l = city.locations[key];
    return { x: l.x, y: l.y, district: def.district, label: def.label };
  }
  return { x: def.x, y: def.y, district: def.district, label: def.label };
}

function ensureMissions(state) {
  if (!state.missions) state.missions = { activeId: null, done: [], progress: {} };
  const m = state.missions;
  if (!Array.isArray(m.done)) m.done = [];
  if (!m.progress || typeof m.progress !== 'object') m.progress = {};
  if (!('activeId' in m)) m.activeId = null;
  if (!('target' in m)) m.target = null;
  if (!('active' in m)) m.active = null;
  return m;
}

function ensureArray(state, key) {
  if (!Array.isArray(state[key])) state[key] = [];
  return state[key];
}

function setMessage(state, text, seconds = 4) {
  const m = ensureMissions(state);
  m.message = { text, until: (state.timeSeconds ?? 0) + seconds };
  // render.js (B1) shows state.toast; mirror the briefing there too.
  state.toast = { text, ttl: seconds };
  if (!state.ui) state.ui = {};
  state.ui.message = text;
  state.ui.messageUntil = m.message.until;
}

/** Advance the shared mission clock (seconds of play). Called by updateMissions. */
function tickClock(state, dt) {
  if (typeof state.timeSeconds !== 'number') state.timeSeconds = 0;
  state.timeSeconds += dt;
}

export const MISSIONS = [
  {
    id: 'm1', kind: 'story', order: 1, title: 'Paket Pertama',
    reward: 150,
    briefing: 'Mira: "Raka, paket pertama. Ambil di Dermaga 3, antar ke Pasar Ikan. Jalan kaki boleh, nyetir lebih cepat."',
    objective: 'Ambil paket di dermaga, antar ke Pasar Ikan.',
  },
  {
    id: 'm2', kind: 'story', order: 2, title: 'Di Bawah Patroli',
    reward: 250,
    briefing: 'Mira: "Paket di Industrial. Polisi lagi galak — jangan sampai wanted naik di atas 1. Pelan-pelan, jangan bikin ribut."',
    objective: 'Ambil paket di Industrial, bawa kembali ke Mira tanpa wanted di atas 1.',
  },
  {
    id: 'm3', kind: 'story', order: 3, title: 'Lepas dari Ekor',
    reward: 300,
    briefing: 'Mira: "Polisi nempel di ekormu, Raka. Wanted 2. Hilang dari pandangan mereka sampai wanted turun ke 0."',
    objective: 'Lepas dari polisi sampai wanted turun ke 0.',
  },
  {
    id: 'm4', kind: 'story', order: 4, title: 'Mobil Pesanan',
    reward: 500,
    briefing: 'Mira: "Ada pesanan: mobil sport merah di Menara Kembar, Downtown. Curi, bawa ke Bengkel Tua di Industrial. Jangan sampai hancur."',
    objective: 'Curi mobil sport merah di Downtown, antar ke Bengkel Tua di Industrial tanpa hancur.',
  },
  {
    id: 'm5', kind: 'story', order: 5, title: 'Gudang Harbor Kings',
    reward: 600,
    briefing: 'Mira: "Harbor Kings nyimpen kargo kita di Gudang 7, pelabuhan. Habisi penjaganya, ambil kargonya. Hati-hati, mereka bersenjata."',
    objective: 'Kalahkan semua penjaga geng di gudang, lalu ambil kargo.',
  },
  {
    id: 'm6', kind: 'story', order: 6, title: 'Finale Pelabuhan',
    reward: 800,
    briefing: 'Mira: "Truk Harbor Kings kabur ke Hills! Kejar dari Harbor, tabrak sampai berhenti sebelum keluar kota!"',
    objective: 'Kejar truk yang kabur, tabrak sampai berhenti sebelum keluar kota.',
  },
  {
    id: 'taxi', kind: 'side', order: 0, title: 'Taksi Verda',
    reward: 50,
    briefing: 'Penumpang menunggu. Antar ke tujuan secepatnya — makin cepat, makin besar tip.',
    objective: 'Antar penumpang ke tujuan. Bisa diulang.',
    repeatable: true,
  },
  {
    id: 'courier', kind: 'side', order: 0, title: 'Kurir Kilat',
    reward: 80,
    briefing: 'Paket kilat, ada timernya. Antar sebelum waktu habis.',
    objective: 'Antar paket sebelum timer habis. Bisa diulang.',
    repeatable: true,
  },
];

export function getMissionDef(id) {
  return MISSIONS.find((m) => m.id === id) || null;
}

export function getActiveMission(state) {
  const m = ensureMissions(state);
  if (!m.activeId) return null;
  const def = getMissionDef(m.activeId);
  if (!def) return null;
  const p = m.progress[m.activeId] || {};
  return { ...def, stage: p.stage ?? 0, progress: p };
}

/** The next story mission the player may start (null when the story is done). */
export function nextStoryMission(state) {
  const m = ensureMissions(state);
  for (const def of MISSIONS) {
    if (def.kind !== 'story') continue;
    if (!m.done.includes(def.id)) return def;
  }
  return null;
}

export function canStartMission(state, id) {
  const m = ensureMissions(state);
  const def = getMissionDef(id);
  if (!def) return { ok: false, reason: `Misi tidak dikenal: ${id}` };
  if (m.activeId) return { ok: false, reason: 'Masih ada misi aktif. Selesaikan atau gagalkan dulu.' };
  if (state.mode === 'busted' || state.mode === 'wasted' || (state.health ?? 100) <= 0) {
    return { ok: false, reason: 'Raka tidak bisa mulai misi sekarang.' };
  }
  if (def.kind === 'story') {
    const next = nextStoryMission(state);
    if (!next || next.id !== id) {
      return { ok: false, reason: `Misi cerita harus berurutan. Berikutnya: ${next ? next.title : '—'}.` };
    }
  }
  return { ok: true };
}

// ---- per-mission setup -------------------------------------------------------

function spawnGuards(state, p) {
  const peds = ensureArray(state, 'peds');
  const base = getLocation(state, 'warehouse');
  const spots = [
    [0, 0], [-90, 40], [90, 30], [-40, -80], [60, -70],
  ];
  p.guardIds = [];
  for (let i = 0; i < GUARD_COUNT; i += 1) {
    const g = {
      id: `m5-guard-${i}`,
      x: base.x + spots[i][0],
      y: base.y + spots[i][1],
      angle: 0,
      color: '#7a3b3b',
      hp: GUARD_HP,
      maxHp: GUARD_HP,
      alive: true,
      down: false,
      gang: 'Harbor Kings',
      missionGuard: true,
      missionId: 'm5',
      kind: 'guard',
      speed: 0,
    };
    peds.push(g);
    p.guardIds.push(g.id);
  }
  p.guardsTotal = GUARD_COUNT;
}

function spawnTargetCar(state) {
  const cars = ensureArray(state, 'cars');
  let car = cars.find((c) => c.id === 'm4-sport');
  if (car) return car;
  const loc = getLocation(state, 'downtownSport');
  car = {
    id: 'm4-sport',
    model: 'sport',
    color: '#e63946',
    x: loc.x,
    y: loc.y,
    angle: 0,
    speed: 0,
    hp: 100,
    maxHp: 100,
    missionCar: true,
    missionId: 'm4',
  };
  cars.push(car);
  return car;
}

// Escape route Harbor -> Hills, following B1's roads (avenues/streets).
const TRUCK_ROUTE = [
  { x: 420, y: 1560 },
  { x: 940, y: 1560 },
  { x: 940, y: 1340 },
  { x: 1720, y: 1340 },
  { x: 1720, y: 1100 },
  { x: 2540, y: 1100 },
];

function spawnTruck(state, p) {
  const cars = ensureArray(state, 'cars');
  let truck = cars.find((c) => c.id === 'm6-truck');
  if (truck) return truck;
  const start = getLocation(state, 'truckStart');
  truck = {
    id: 'm6-truck',
    model: 'truck',
    color: '#3a6ea5',
    x: start.x,
    y: start.y,
    angle: 0,
    speed: 0,
    hp: TRUCK_HP,
    maxHp: TRUCK_HP,
    fleeing: true,
    missionTruck: true,
    missionId: 'm6',
    waypoints: TRUCK_ROUTE.map((w) => ({ ...w })),
  };
  if (state.city && Array.isArray(state.city.m6Route)) truck.waypoints = state.city.m6Route;
  cars.push(truck);
  p.waypointIndex = 0;
  return truck;
}

function pickTaxiTrip(state, p) {
  const stands = ['taxiStandA', 'taxiStandB', 'taxiStandC', 'taxiStandD'];
  const fromKey = stands[Math.floor(Math.random() * stands.length)];
  let toKey = stands[Math.floor(Math.random() * stands.length)];
  while (toKey === fromKey) toKey = stands[Math.floor(Math.random() * stands.length)];
  p.pickupKey = fromKey;
  p.destKey = toKey;
  p.pickup = getLocation(state, fromKey);
  p.dest = getLocation(state, toKey);
  p.elapsed = 0;
}

function pickCourierTrip(state, p) {
  const fromKey = Math.random() < 0.5 ? 'dockPickup' : 'industrialDrop';
  const toKey = fromKey === 'dockPickup' ? 'marketShop' : 'miraBase';
  p.pickupKey = fromKey;
  p.destKey = toKey;
  p.pickup = getLocation(state, fromKey);
  p.dest = getLocation(state, toKey);
  p.timeLeft = COURIER_TIME;
  p.elapsed = 0;
}

/**
 * Keep render.js's fields in sync: state.missions.active {id,name,objective}
 * (top-centre banner) and state.missions.target {x,y,label} (world beacon +
 * minimap blip). Null when no mission is active.
 */
export function syncMissionRender(state) {
  const m = ensureMissions(state);
  const active = getActiveMission(state);
  if (!active) {
    m.active = null;
    m.target = null;
    return;
  }
  const target = getMissionTarget(state);
  m.active = { id: active.id, name: active.title, objective: objectiveText(state) || active.objective };
  m.target = target ? { x: target.x, y: target.y, label: target.label } : null;
}

/**
 * Start a mission. Returns {ok, reason?}. On success sets state.missions.activeId
 * and initial progress; the HUD reads the briefing from getActiveMission().
 */
export function startMission(state, id) {
  const check = canStartMission(state, id);
  if (!check.ok) return check;
  const m = ensureMissions(state);
  const def = getMissionDef(id);
  const prev = m.progress[id] || {};
  const p = { stage: 0, startedAt: state.timeSeconds ?? 0, elapsed: 0 };
  // Repeatable side jobs keep cumulative stats across runs.
  if (def && def.kind === 'side') {
    p.trips = prev.trips ?? 0;
    p.earned = prev.earned ?? 0;
  }
  m.progress[id] = p;
  m.activeId = id;
  m.failedId = null;

  if (id === 'm3') {
    state.wanted = 2;
    p.evadeStarted = true;
  }
  if (id === 'm4') spawnTargetCar(state);
  if (id === 'm5') spawnGuards(state, p);
  if (id === 'm6') spawnTruck(state, p);
  if (id === 'taxi') pickTaxiTrip(state, p);
  if (id === 'courier') pickCourierTrip(state, p);

  setMessage(state, `${def.title} — ${def.briefing}`, 6);
  syncMissionRender(state);
  return { ok: true };
}

function completeMission(state, id, bonus = 0) {
  const m = ensureMissions(state);
  const def = getMissionDef(id);
  const reward = (def ? def.reward : 0) + bonus;
  state.money = (state.money ?? 0) + reward;
  if (def && def.kind === 'story' && !m.done.includes(id)) m.done.push(id);
  if (def && def.kind === 'side') {
    const p = m.progress[id] || {};
    p.trips = (p.trips ?? 0) + 1;
    p.earned = (p.earned ?? 0) + reward;
    m.progress[id] = p;
  }
  m.activeId = null;
  m.lastResult = { id, outcome: 'completed', reward, at: state.timeSeconds ?? 0 };
  setMessage(state, `Misi selesai: ${def ? def.title : id}! +$${reward}`, 5);
  syncMissionRender(state);
  return { type: 'completed', id, reward, title: def ? def.title : id };
}

function failMission(state, id, reason) {
  const m = ensureMissions(state);
  const def = getMissionDef(id);
  m.activeId = null;
  m.lastResult = { id, outcome: 'failed', reason, at: state.timeSeconds ?? 0 };
  setMessage(state, `Misi gagal: ${def ? def.title : id} — ${reason}`, 5);
  syncMissionRender(state);
  return { type: 'failed', id, reason, title: def ? def.title : id };
}

function playerPos(state) {
  const pl = state.player || {};
  return { x: pl.x ?? 0, y: pl.y ?? 0 };
}

function nearPlayer(state, loc, radius = REACH) {
  const p = playerPos(state);
  return dist(p.x, p.y, loc.x, loc.y) <= radius;
}

function aliveGuards(state) {
  const peds = Array.isArray(state.peds) ? state.peds : [];
  const enemies = Array.isArray(state.enemies) ? state.enemies : [];
  return [...peds, ...enemies].filter(
    (g) => g && g.missionGuard && g.missionId === 'm5' && g.alive !== false && !g.down && (g.hp ?? 1) > 0,
  );
}

function findCar(state, id) {
  const cars = Array.isArray(state.cars) ? state.cars : [];
  return cars.find((c) => c && c.id === id) || null;
}

// ---- per-frame update ---------------------------------------------------------

function updateStory(state, dt, id, p) {
  const pl = state.player || {};
  const px = pl.x ?? 0;
  const py = pl.y ?? 0;

  // Any mission fails if Raka goes down.
  if ((state.health ?? 100) <= 0) return failMission(state, id, 'Raka tumbang.');

  if (id === 'm1') {
    if (p.stage === 0) {
      if (nearPlayer(state, getLocation(state, 'dockPickup'))) {
        p.stage = 1;
        p.hasPackage = true;
        setMessage(state, 'Paket diambil! Antar ke Pasar Ikan.', 4);
      }
    } else if (nearPlayer(state, getLocation(state, 'marketShop'))) {
      return completeMission(state, id);
    }
    return null;
  }

  if (id === 'm2') {
    if ((state.wanted ?? 0) > 1) return failMission(state, id, 'Wanted naik di atas 1 — patroli mengejarmu.');
    if (p.stage === 0) {
      if (nearPlayer(state, getLocation(state, 'industrialDrop'))) {
        p.stage = 1;
        p.hasPackage = true;
        setMessage(state, 'Paket didapat! Bawa kembali ke Mira di Harbor. Jangan bikin ribut.', 4);
      }
    } else if (nearPlayer(state, getLocation(state, 'miraBase'))) {
      return completeMission(state, id);
    }
    return null;
  }

  if (id === 'm3') {
    if ((state.wanted ?? 0) <= 0) return completeMission(state, id);
    return null;
  }

  if (id === 'm4') {
    const car = findCar(state, 'm4-sport') || spawnTargetCar(state);
    if (p.stage === 0) {
      if (pl.inCar && pl.carId === 'm4-sport') {
        p.stage = 1;
        setMessage(state, 'Mobil sport didapat! Bawa ke Bengkel Tua di Industrial — jangan sampai hancur.', 4);
      }
    } else {
      if (!car || (car.hp ?? 100) <= 0) return failMission(state, id, 'Mobil pesanan hancur.');
      if (pl.inCar && pl.carId === 'm4-sport' && nearPlayer(state, getLocation(state, 'industrialGarage'))) {
        return completeMission(state, id);
      }
    }
    return null;
  }

  if (id === 'm5') {
    const guards = aliveGuards(state);
    p.guardsLeft = guards.length;
    if (p.stage === 0) {
      if (guards.length === 0) {
        p.stage = 1;
        setMessage(state, 'Semua penjaga tumbang! Ambil kargo di tengah gudang.', 4);
      }
    } else if (nearPlayer(state, getLocation(state, 'warehouse'))) {
      return completeMission(state, id);
    }
    return null;
  }

  if (id === 'm6') {
    const truck = findCar(state, 'm6-truck');
    if (!truck) return failMission(state, id, 'Truk menghilang.');
    if ((truck.hp ?? TRUCK_HP) <= 0) return completeMission(state, id);
    // Drive the truck along its escape route.
    const wps = truck.waypoints || [];
    const lastWp = wps[wps.length - 1];
    // Reaching the final exit point by any means is an escape.
    if (lastWp && dist(truck.x, truck.y, lastWp.x, lastWp.y) < 40) {
      return failMission(state, id, 'Truk keluar kota lewat Hills.');
    }
    const wi = p.waypointIndex ?? 0;
    const wp = wps[wi];
    if (wp) {
      const d = dist(truck.x, truck.y, wp.x, wp.y);
      if (d < 40) {
        if (wi >= wps.length - 1) return failMission(state, id, 'Truk keluar kota lewat Hills.');
        p.waypointIndex = wi + 1;
      } else {
        const step = TRUCK_SPEED * dt;
        truck.x += ((wp.x - truck.x) / d) * step;
        truck.y += ((wp.y - truck.y) / d) * step;
        truck.angle = Math.atan2(wp.y - truck.y, wp.x - truck.x);
        truck.speed = TRUCK_SPEED;
      }
    }
    // Ram: player (on foot or in a car) touches the truck.
    const dPlayer = dist(px, py, truck.x, truck.y);
    p.lastRam = p.lastRam ?? -10;
    if (dPlayer <= RAM_DIST && (state.timeSeconds ?? 0) - p.lastRam >= RAM_COOLDOWN) {
      p.lastRam = state.timeSeconds ?? 0;
      truck.hp = (truck.hp ?? TRUCK_HP) - RAM_DAMAGE;
      p.hits = (p.hits ?? 0) + 1;
      setMessage(state, `Tabrakan! Truk rusak (${Math.max(0, truck.hp)}/100). Terus tabrak!`, 2);
      if (truck.hp <= 0) return completeMission(state, id);
    }
    // Escape: player too far away for too long.
    if (dPlayer > ESCAPE_DIST) {
      p.farTime = (p.farTime ?? 0) + dt;
      if (p.farTime >= ESCAPE_TIME) return failMission(state, id, 'Truk lolos — kamu terlalu jauh.');
    } else {
      p.farTime = 0;
    }
    return null;
  }

  return null;
}

function updateSide(state, dt, id, p) {
  if ((state.health ?? 100) <= 0) return failMission(state, id, 'Raka tumbang.');
  p.elapsed = (p.elapsed ?? 0) + dt;

  if (id === 'taxi') {
    if (p.stage === 0) {
      if (nearPlayer(state, p.pickup || getLocation(state, p.pickupKey || 'taxiStandA'))) {
        p.stage = 1;
        setMessage(state, `Penumpang naik! Antar ke ${p.dest ? p.dest.label : 'tujuan'}.`, 4);
      }
    } else if (nearPlayer(state, p.dest || getLocation(state, p.destKey || 'taxiStandB'))) {
      const bonus = p.elapsed <= TAXI_FAST_TIME ? 20 : 0;
      return completeMission(state, id, bonus);
    }
    return null;
  }

  if (id === 'courier') {
    p.timeLeft = (p.timeLeft ?? COURIER_TIME) - dt;
    if (p.timeLeft <= 0) return failMission(state, id, 'Waktu habis — paket terlambat.');
    if (p.stage === 0) {
      if (nearPlayer(state, p.pickup || getLocation(state, p.pickupKey || 'dockPickup'))) {
        p.stage = 1;
        p.hasPackage = true;
        setMessage(state, `Paket diambil! Sisa waktu ${Math.ceil(p.timeLeft)} dtk — antar ke tujuan.`, 4);
      }
    } else if (nearPlayer(state, p.dest || getLocation(state, p.destKey || 'marketShop'))) {
      return completeMission(state, id);
    }
    return null;
  }
  return null;
}

/**
 * Advance the active mission one frame. Returns an event object
 * {type:'completed'|'failed', id, ...} when a mission resolves, else null.
 * Also advances the mission clock, expires transient messages and keeps
 * render.js's missions.active / missions.target in sync.
 */
export function updateMissions(state, dt) {
  const m = ensureMissions(state);
  tickClock(state, dt);
  if (m.message && (state.timeSeconds ?? 0) > m.message.until) m.message = null;
  if (state.toast && typeof state.toast.ttl === 'number') {
    state.toast.ttl -= dt;
    if (state.toast.ttl <= 0) state.toast = null;
  }
  if (!m.activeId) {
    syncMissionRender(state);
    return null;
  }
  const def = getMissionDef(m.activeId);
  if (!def) {
    m.activeId = null;
    syncMissionRender(state);
    return null;
  }
  const p = m.progress[m.activeId] || {};
  m.progress[m.activeId] = p;
  const event = def.kind === 'story'
    ? updateStory(state, dt, m.activeId, p)
    : updateSide(state, dt, m.activeId, p);
  syncMissionRender(state);
  return event;
}

/** Current objective target for arrow + minimap blip, or null when idle. */
export function getMissionTarget(state) {
  const active = getActiveMission(state);
  if (!active) return null;
  const p = active.progress || {};
  switch (active.id) {
    case 'm1':
      return p.stage === 0
        ? { ...getLocation(state, 'dockPickup'), label: 'Ambil paket' }
        : { ...getLocation(state, 'marketShop'), label: 'Antar paket' };
    case 'm2':
      return p.stage === 0
        ? { ...getLocation(state, 'industrialDrop'), label: 'Ambil paket' }
        : { ...getLocation(state, 'miraBase'), label: 'Kembali ke Mira' };
    case 'm3':
      return null; // evade: no fixed point; HUD shows "lepas dari polisi"
    case 'm4': {
      if (p.stage === 0) {
        const car = findCar(state, 'm4-sport');
        const loc = car ? { x: car.x, y: car.y } : getLocation(state, 'downtownSport');
        return { ...loc, label: 'Mobil sport merah' };
      }
      return { ...getLocation(state, 'industrialGarage'), label: 'Bengkel Tua (Industrial)' };
    }
    case 'm5':
      return p.stage === 0
        ? { ...getLocation(state, 'warehouse'), label: `Kalahkan penjaga (${p.guardsLeft ?? GUARD_COUNT} tersisa)` }
        : { ...getLocation(state, 'warehouse'), label: 'Ambil kargo' };
    case 'm6': {
      const truck = findCar(state, 'm6-truck');
      if (!truck) return { ...getLocation(state, 'hillsExit'), label: 'Truk kabur' };
      return { x: truck.x, y: truck.y, label: `Tabrak truk! (${Math.max(0, truck.hp ?? TRUCK_HP)}/100)` };
    }
    case 'taxi':
      return p.stage === 0
        ? { ...(p.pickup || getLocation(state, 'taxiStandA')), label: 'Jemput penumpang' }
        : { ...(p.dest || getLocation(state, 'taxiStandB')), label: 'Antar penumpang' };
    case 'courier':
      return p.stage === 0
        ? { ...(p.pickup || getLocation(state, 'dockPickup')), label: 'Ambil paket' }
        : { ...(p.dest || getLocation(state, 'marketShop')), label: `Antar paket (${Math.ceil(p.timeLeft ?? COURIER_TIME)} dtk)` };
    default:
      return null;
  }
}

/** Blips for B1's minimap (render.js): mission target + police + truck. */
export function getMinimapBlips(state) {
  const blips = [];
  const target = getMissionTarget(state);
  if (target) blips.push({ x: target.x, y: target.y, color: '#ffd23f', kind: 'mission' });
  const police = Array.isArray(state.police) ? state.police : [];
  for (const cop of police) {
    if (cop) blips.push({ x: cop.x ?? 0, y: cop.y ?? 0, color: '#4fc3f7', kind: 'police' });
  }
  const truck = findCar(state, 'm6-truck');
  if (truck && getActiveMission(state)?.id === 'm6') {
    blips.push({ x: truck.x, y: truck.y, color: '#e63946', kind: 'truck' });
  }
  return blips;
}

/** Distance (px) from the player to the current target, or null. */
export function distanceToTarget(state) {
  const t = getMissionTarget(state);
  if (!t) return null;
  const p = playerPos(state);
  return dist(p.x, p.y, t.x, t.y);
}

/** One-line objective text for the HUD tracker. */
export function objectiveText(state) {
  const active = getActiveMission(state);
  if (!active) return null;
  const target = getMissionTarget(state);
  const d = distanceToTarget(state);
  const distText = d === null ? '' : ` — ${Math.max(0, Math.round(d / 10))} m`;
  if (active.id === 'm3') return `${active.title}: lepas dari polisi sampai wanted 0 (sekarang ${state.wanted ?? 0})`;
  if (active.id === 'm5' && active.progress.stage === 0) {
    return `${active.title}: kalahkan penjaga (${active.progress.guardsLeft ?? GUARD_COUNT} tersisa)`;
  }
  return `${active.title}: ${target ? target.label : active.objective}${distText}`;
}

export { REACH, COURIER_TIME, TAXI_FAST_TIME, GUARD_COUNT, TRUCK_HP, TRUCK_ROUTE };
