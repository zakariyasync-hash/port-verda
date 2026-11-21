// combat.js — Port Verda (Builder B2: Vehicles & Life).
//
// Punch, shooting, bullets, Harbor Kings gang enemies, health/ammo
// pickups, and player damage / wasted. Written from scratch in this
// session. Vanilla ES module, no library, no network, no external asset.
// Pure logic over the shared `state` object.
//
// STATE CONTRACT (agreed with B1 main.js / B3 missions.js):
//   state = { mode, time, money, health, wanted, wantedTimer,
//             player: { x, y, angle, speed, onFoot, inCar, carId, invulnerable },
//             cars: [], traffic: [], peds: [], police: [],
//             missions: { activeId, active, target, done: [], progress: {} },
//             camera: { x, y }, input, muted, fx: [], toast, city }
//   Combat state created here (all plain data): state.ammo (HUD reads it;
//   hud.js shows `state.ammo ?? 30`), state.bullets,
//   state.enemies (gang members), state.pickups, state.kills.
//   A bullet is { x, y, vx, vy, ox, oy, damage, fromPlayer, ttl }.
//   A gang enemy is { id, x, y, angle, speed, hp, maxHp, alive,
//   gang: 'Harbor Kings', kind: 'gang', state, shootCooldown,
//   meleeCooldown, hx, hy } — hp/alive match missions.js's guards.
//   A pickup is { kind: 'health' | 'ammo', x, y }.
//   Mission 5's guards live in state.peds (B3 missions.js spawns them
//   with missionGuard:true, missionId:'m5', hp, alive) — punch and
//   bullets damage them here, and updateCombat makes the living ones
//   shoot back, so mission 5 is a real fight.
//
// WIRING (main.js B1): step 6 calls updateCombat(state, dt, input) every
// step while playing. main.js consumes the KeyF edge in step 1 before
// this runs, so F is edge-detected here from the held-key set instead.
// A mouse click shoots at mouse + camera (the same world conversion
// main.js's fallback uses). punch(state) and shoot(state, x, y) are the
// standalone primitives for tests and for missions.js.
//
// CRIMES: punching or shooting a pedestrian, and shooting at all, raise
// the wanted level only when witnessed (police.js witnessed(): a patrol
// car within 500 px or someone on foot within 300 px). Hitting a Harbor
// Kings guard or gang member never counts as a crime against a civilian.

import { CFG } from './config.js';
import { buildCity, clampToWorld, collidesBuilding, isWater } from './city.js';
import { createRng } from './rng.js';
import { saveGame } from './save.js';
import { addWanted, witnessed } from './police.js';
import { initAudio, playShot, playPunch, playPickup } from './audio.js';

const rng = createRng(CFG.SEED + 404);

const PUNCH_ARC = 1.4; // radians either side of the facing direction
const PUNCH_REACH = CFG.PUNCH_RANGE + 20; // 54 px, like main.js's fallback
const BULLET_SPEED = 950;
const ENEMY_BULLET_SPEED = 700;
const ENEMY_BULLET_DAMAGE = 9;
const ENEMY_MELEE_DAMAGE = 12;
const AMMO_START = 30; // matches hud.js's `state.ammo ?? 30` default
const AMMO_MAX = 120;
const KILL_REWARD = 25;
const GANG = 'Harbor Kings';

let cityCache = null;
function cityOf(state) {
  if (state && state.city) return state.city;
  if (!cityCache) cityCache = buildCity(CFG.SEED);
  return cityCache;
}

function ensureCombat(state) {
  if (!Array.isArray(state.bullets)) state.bullets = [];
  if (!Array.isArray(state.enemies)) state.enemies = [];
  if (!Array.isArray(state.pickups)) state.pickups = [];
  if (!Array.isArray(state.peds)) state.peds = [];
  if (!Array.isArray(state.cars)) state.cars = [];
  if (!Array.isArray(state.traffic)) state.traffic = [];
  if (!Array.isArray(state.police)) state.police = [];
  if (typeof state.ammo !== 'number') state.ammo = AMMO_START;
  if (typeof state.kills !== 'number') state.kills = 0;
  if (typeof state.punchCooldown !== 'number') state.punchCooldown = 0;
  if (typeof state.shootCooldown !== 'number') state.shootCooldown = 0;
  if (typeof state.health !== 'number') state.health = CFG.PLAYER_MAX_HEALTH;
  if (typeof state.money !== 'number') state.money = CFG.START_MONEY;
}

function nextEnemyId(state) {
  state._nextEnemyId = (state._nextEnemyId ?? 0) + 1;
  return `gang-${state._nextEnemyId}`;
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

// Combat sounds (B3 audio.js). main.js's createAudio wiring does not
// exist in audio.js, so nothing else starts the shared AudioContext:
// combat starts it lazily on the first user-triggered punch/shot/pickup
// (a key press / click is a user gesture, so the context may run), and
// respects the game's mute flag. Audio never breaks combat.
let audioStarted = false;
function combatSound(state, play) {
  if (state.muted) return;
  if (!audioStarted) {
    audioStarted = true;
    try { initAudio(); } catch { /* audio never breaks combat */ }
  }
  try { play(); } catch { /* audio never breaks combat */ }
}

function playerCar(state) {
  if (!state.player.inCar || !state.player.carId) return null;
  return state.cars.find((c) => c.id === state.player.carId) || null;
}

function facingOf(state) {
  const car = playerCar(state);
  return car ? car.angle : state.player.angle;
}

// --- player damage -------------------------------------------------------------

/**
 * Hurt the player. Brief invulnerability (0.35 s) stops a burst of enemy
 * fire from melting the health bar in one frame. At 0 health the run is
 * wasted. Returns true when damage landed.
 */
export function damagePlayer(state, amount, source = 'hit') {
  ensureCombat(state);
  if (state.mode !== 'playing') return false;
  if (state.player.invulnerable > 0) return false;
  state.health = Math.max(0, state.health - amount);
  state.player.invulnerable = 0.35;
  state.lastDamageAt = state.time;
  state.fx.push({
    kind: 'punch',
    x: state.player.x, y: state.player.y,
    ttl: 0.18, max: 0.18,
  });
  if (state.health <= 0) {
    state.health = 0;
    state.mode = 'wasted';
    setToast(state, 'Kamu tumbang! Tekan Enter untuk mulai lagi.');
    try { saveGame(state); } catch { /* saving never breaks the game */ }
  }
  return true;
}

export function healPlayer(state, amount) {
  ensureCombat(state);
  state.health = Math.min(CFG.PLAYER_MAX_HEALTH, state.health + amount);
  return state.health;
}

// --- pickups -------------------------------------------------------------------

export function spawnHealthPack(state, x, y) {
  ensureCombat(state);
  state.pickups.push({ kind: 'health', x, y });
  return state.pickups[state.pickups.length - 1];
}

export function spawnAmmoBox(state, x, y) {
  ensureCombat(state);
  state.pickups.push({ kind: 'ammo', x, y });
  return state.pickups[state.pickups.length - 1];
}

// --- gang enemies --------------------------------------------------------------

/**
 * Spawn `count` Harbor Kings members around (x, y) — the gang for
 * mission 5. Positions that land inside a building or the water are
 * nudged onto the nearest road. Enemies fight back (see updateCombat).
 */
export function spawnGangEnemies(state, x, y, count = 4) {
  ensureCombat(state);
  const city = cityOf(state);
  const spots = [[0, 0], [-70, 40], [70, 30], [-40, -70], [60, -70], [0, 90], [-90, -30], [90, -40]];
  const made = [];
  for (let i = 0; i < count; i++) {
    const off = spots[i % spots.length];
    let ex = x + off[0];
    let ey = y + off[1];
    if (collidesBuilding(city, ex, ey, 12) || isWater(city, ex, ey)) {
      const near = city.nearestRoad(ex, ey);
      ex = near ? near.x : x;
      ey = near ? near.y : y;
    }
    const c = clampToWorld(ex, ey, 16);
    const enemy = {
      id: nextEnemyId(state),
      x: c.x, y: c.y,
      angle: rng.next() * Math.PI * 2,
      speed: 150,
      hp: 100, maxHp: 100,
      alive: true,
      gang: GANG,
      kind: 'gang',
      state: 'chase',
      shootCooldown: 0.5 + rng.next(),
      meleeCooldown: 0,
      hx: c.x, hy: c.y,
    };
    state.enemies.push(enemy);
    made.push(enemy);
  }
  return made;
}

function killEnemy(state, enemy) {
  const idx = state.enemies.indexOf(enemy);
  if (idx >= 0) state.enemies.splice(idx, 1);
  state.kills += 1;
  state.money += KILL_REWARD;
  if (rng.next() < 0.25) spawnHealthPack(state, enemy.x, enemy.y);
  setToast(state, `Harbor Kings tumbang! +$${KILL_REWARD}`);
}

function damageEnemy(state, enemy, amount, kx, ky) {
  enemy.hp -= amount;
  if (kx || ky) {
    const city = cityOf(state);
    const nx = enemy.x + kx * 14;
    const ny = enemy.y + ky * 14;
    if (!collidesBuilding(city, nx, ny, 12) && !isWater(city, nx, ny)) {
      enemy.x = nx; enemy.y = ny;
    }
    const c = clampToWorld(enemy.x, enemy.y, 16);
    enemy.x = c.x; enemy.y = c.y;
  }
  if (enemy.hp <= 0) killEnemy(state, enemy);
}

// --- punch ---------------------------------------------------------------------

/**
 * F: a close-range swing (on foot only). Hits the nearest hostile or
 * pedestrian inside 54 px and a 160-degree arc in front of the player.
 * A guard or gang member takes 20 damage; a pedestrian is knocked down
 * and the swing is a crime when anyone sees it.
 */
export function punch(state) {
  ensureCombat(state);
  if (state.mode !== 'playing') return false;
  if (state.player.inCar) return false;
  if (state.punchCooldown > 0) return false;
  state.punchCooldown = CFG.PUNCH_COOLDOWN;
  combatSound(state, playPunch);
  const p = state.player;
  const facing = facingOf(state);
  state.fx.push({
    kind: 'punch',
    x: p.x + Math.cos(facing) * 22,
    y: p.y + Math.sin(facing) * 22,
    ttl: 0.18, max: 0.18,
  });

  let best = null;
  let bestD = PUNCH_REACH;
  let bestKind = null;
  const consider = (target, kind) => {
    const d = dist(p.x, p.y, target.x, target.y);
    if (d >= bestD) return;
    const diff = Math.abs(normAngle(Math.atan2(target.y - p.y, target.x - p.x) - facing));
    if (diff > PUNCH_ARC) return;
    best = target; bestD = d; bestKind = kind;
  };
  for (const e of state.enemies) if (e.alive !== false) consider(e, 'enemy');
  for (const ped of state.peds) {
    if (ped.down || ped.alive === false) continue;
    consider(ped, ped.missionGuard ? 'guard' : 'ped');
  }
  if (!best) return false;

  const kx = Math.cos(facing);
  const ky = Math.sin(facing);
  if (bestKind === 'enemy') {
    damageEnemy(state, best, CFG.PUNCH_DAMAGE, kx, ky);
  } else if (bestKind === 'guard') {
    best.hp = (best.hp ?? 100) - CFG.PUNCH_DAMAGE;
    if (best.hp <= 0) { best.alive = false; best.down = true; }
  } else {
    best.down = true;
    best.downTimer = 4;
    best.state = 'flee';
    best.fleeTimer = 2.5;
    best.fleeX = p.x; best.fleeY = p.y;
    state.dangerZone = { x: p.x, y: p.y, radius: 220, ttl: 1.5, kind: 'punch' };
    if (witnessed(state, p.x, p.y)) {
      if (addWanted(state, CFG.CRIME_HEAT_PUNCH, 'pukul')) {
        setToast(state, 'Kamu memukul pejalan kaki! Polisi waspada.');
      }
    }
  }
  return true;
}

// --- shooting ------------------------------------------------------------------

/**
 * Fire one round at a world point (mouse click). Works on foot and from
 * a car (worse spread while driving). Consumes one ammo, starts a bullet,
 * paints a tracer, and scares nearby pedestrians. Firing is a crime
 * when anyone sees it. Returns false when nothing was fired.
 */
export function shoot(state, targetX, targetY) {
  ensureCombat(state);
  if (state.mode !== 'playing') return false;
  if (state.shootCooldown > 0) return false;
  if (state.ammo <= 0) {
    setToast(state, 'Amunisi habis! Cari kotak amunisi.');
    state.shootCooldown = 0.3;
    return false;
  }
  state.shootCooldown = CFG.SHOOT_COOLDOWN;
  state.ammo -= 1;
  combatSound(state, playShot);
  const p = state.player;
  const car = playerCar(state);
  const facing = facingOf(state);
  const mx = p.x + Math.cos(facing) * 20;
  const my = p.y + Math.sin(facing) * 20;
  const spread = (car ? 0.09 : 0.05) * (rng.next() * 2 - 1);
  const aim = Math.atan2(targetY - my, targetX - mx) + spread;
  state.bullets.push({
    x: mx, y: my,
    vx: Math.cos(aim) * BULLET_SPEED,
    vy: Math.sin(aim) * BULLET_SPEED,
    ox: mx, oy: my,
    damage: CFG.SHOOT_DAMAGE,
    fromPlayer: true,
    ttl: 1,
  });
  const ex = mx + Math.cos(aim) * CFG.SHOOT_RANGE;
  const ey = my + Math.sin(aim) * CFG.SHOOT_RANGE;
  state.fx.push({ kind: 'tracer', x1: mx, y1: my, x2: ex, y2: ey, ttl: 0.12, max: 0.12 });
  state.dangerZone = { x: p.x, y: p.y, radius: 280, ttl: 1.2, kind: 'shot' };
  if (witnessed(state, p.x, p.y)) {
    if (addWanted(state, CFG.CRIME_HEAT_SHOOT, 'tembak')) {
      setToast(state, 'Tembakan! Wanted naik.');
    }
  }
  return true;
}

function fireEnemyBullet(state, from, tx, ty) {
  const aim = Math.atan2(ty - from.y, tx - from.x) + 0.12 * (rng.next() * 2 - 1);
  state.bullets.push({
    x: from.x, y: from.y,
    vx: Math.cos(aim) * ENEMY_BULLET_SPEED,
    vy: Math.sin(aim) * ENEMY_BULLET_SPEED,
    ox: from.x, oy: from.y,
    damage: ENEMY_BULLET_DAMAGE,
    fromPlayer: false,
    ttl: 1,
  });
  state.fx.push({
    kind: 'tracer',
    x1: from.x, y1: from.y,
    x2: from.x + Math.cos(aim) * 160,
    y2: from.y + Math.sin(aim) * 160,
    ttl: 0.1, max: 0.1,
  });
}

// Move an enemy or guard one step, sliding along buildings and water.
function moveFighter(city, e, nx, ny) {
  const blocked = (x, y) => collidesBuilding(city, x, y, 12) || isWater(city, x, y);
  if (!blocked(nx, ny)) { e.x = nx; e.y = ny; return; }
  // A slide only counts when it actually moves (see vehicles.js).
  if (nx !== e.x && !blocked(nx, e.y)) { e.x = nx; return; }
  if (ny !== e.y && !blocked(e.x, ny)) { e.y = ny; }
}

// --- main.js step-6 entry point --------------------------------------------------

let prevKeys = new Set();

/**
 * The main.js step-6 entry point. Reads F (edge-detected from the held
 * key set, because main.js consumes the KeyF edge in step 1) and mouse
 * clicks (world = mouse + camera), steps bullets, runs gang-enemy and
 * guard AI, and hands out pickups.
 */
export function updateCombat(state, dt, input) {
  ensureCombat(state);
  if (state.mode !== 'playing') {
    if (input && input.keys instanceof Set) prevKeys = new Set(input.keys);
    return;
  }
  const city = cityOf(state);
  const p = state.player;
  state.punchCooldown = Math.max(0, state.punchCooldown - dt);
  state.shootCooldown = Math.max(0, state.shootCooldown - dt);

  // F punch: edge-detect the held key (main.js ate the KeyF edge already).
  if (input) {
    let pressedF = false;
    if (input.keys instanceof Set) {
      pressedF = input.keys.has('KeyF') && !prevKeys.has('KeyF');
      prevKeys = new Set(input.keys);
    }
    if (!pressedF && typeof input.keyPressed === 'function' && input.keyPressed('KeyF')) pressedF = true;
    if (!pressedF && typeof input.wasPressed === 'function' && input.wasPressed('KeyF')) pressedF = true;
    if (pressedF) punch(state);

    // Mouse click: shoot at the world point under the cursor.
    if (input.mouse && input.mouse.clicked) {
      const cam = state.camera || { x: 0, y: 0 };
      const wx = input.mouse.x + cam.x;
      const wy = input.mouse.y + cam.y;
      input.mouse.clicked = false;
      shoot(state, wx, wy);
    }
  }

  // --- bullets -----------------------------------------------------------------
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.ttl -= dt;
    const travelled = dist(b.x, b.y, b.ox, b.oy);
    if (b.ttl <= 0 || travelled > CFG.SHOOT_RANGE + 40) {
      state.bullets.splice(i, 1);
      continue;
    }
    if (collidesBuilding(city, b.x, b.y, 0) || isWater(city, b.x, b.y)) {
      state.bullets.splice(i, 1);
      continue;
    }
    let consumed = false;
    if (b.fromPlayer) {
      // Gang enemies.
      for (const e of [...state.enemies]) {
        if (e.alive === false) continue;
        if (dist(b.x, b.y, e.x, e.y) < 20) {
          damageEnemy(state, e, b.damage, b.vx / BULLET_SPEED, b.vy / BULLET_SPEED);
          consumed = true;
          break;
        }
      }
      // Mission guards (mission 5, in state.peds).
      if (!consumed) {
        for (const ped of state.peds) {
          if (!ped.missionGuard || ped.alive === false) continue;
          if (dist(b.x, b.y, ped.x, ped.y) < 18) {
            ped.hp = (ped.hp ?? 100) - b.damage;
            if (ped.hp <= 0) { ped.alive = false; ped.down = true; }
            consumed = true;
            break;
          }
        }
      }
      // Pedestrians: a hit knocks them down and is a serious crime.
      if (!consumed) {
        for (const ped of state.peds) {
          if (ped.down || ped.missionGuard) continue;
          if (dist(b.x, b.y, ped.x, ped.y) < 16) {
            ped.down = true;
            ped.downTimer = 4;
            ped.state = 'flee';
            ped.fleeTimer = 2.5;
            ped.fleeX = p.x; ped.fleeY = p.y;
            state.dangerZone = { x: ped.x, y: ped.y, radius: 260, ttl: 1.5, kind: 'shot' };
            if (addWanted(state, CFG.CRIME_HEAT_SHOOT, 'tembak')) {
              setToast(state, 'Kamu menembak pejalan kaki! Wanted naik.');
            }
            consumed = true;
            break;
          }
        }
      }
      // Patrol cars: sparks and a star, but cars have no health model.
      if (!consumed) {
        for (const cop of state.police) {
          if (dist(b.x, b.y, cop.x, cop.y) < 24) {
            state.fx.push({ kind: 'punch', x: b.x, y: b.y, ttl: 0.15, max: 0.15 });
            if (addWanted(state, 1, 'tembak polisi')) setToast(state, 'Kamu menembak polisi!');
            consumed = true;
            break;
          }
        }
      }
      // Traffic cars: the driver bails out and the car is abandoned.
      if (!consumed) {
        for (let t = 0; t < state.traffic.length; t++) {
          const car = state.traffic[t];
          if (dist(b.x, b.y, car.x, car.y) < 24) {
            state.traffic.splice(t, 1);
            car.speed = 0;
            car.parked = true;
            car.abandoned = true;
            state.cars.push(car);
            const side = car.angle + Math.PI / 2;
            const driver = {
              id: `ped-driver-${car.id}`,
              x: car.x + Math.cos(side) * 30,
              y: car.y + Math.sin(side) * 30,
              angle: car.angle, speed: 0, color: '#e0a458',
              down: false, from: -1, to: -1, t: 0, side: 1,
              state: 'flee', fleeTimer: 3, fleeX: car.x, fleeY: car.y,
            };
            const c = clampToWorld(driver.x, driver.y, CFG.PED_RADIUS);
            driver.x = c.x; driver.y = c.y;
            state.peds.push(driver);
            if (witnessed(state, car.x, car.y)) {
              addWanted(state, 1, 'tembak mobil');
            }
            consumed = true;
            break;
          }
        }
      }
    } else if (dist(b.x, b.y, p.x, p.y) < 16) {
      // Enemy fire: the player car does not shield the driver.
      damagePlayer(state, b.damage, 'shot');
      consumed = true;
    }
    if (consumed) state.bullets.splice(i, 1);
  }

  // --- gang enemies: chase, shoot, brawl ---------------------------------------
  for (const e of [...state.enemies]) {
    if (e.alive === false) continue;
    e.shootCooldown = Math.max(0, (e.shootCooldown ?? 0) - dt);
    e.meleeCooldown = Math.max(0, (e.meleeCooldown ?? 0) - dt);
    const d = dist(e.x, e.y, p.x, p.y);
    if (d < 420) {
      e.state = 'chase';
      e.angle = Math.atan2(p.y - e.y, p.x - e.x);
      if (d > 60) {
        moveFighter(city, e, e.x + Math.cos(e.angle) * e.speed * dt, e.y + Math.sin(e.angle) * e.speed * dt);
      }
      if (d < 320 && e.shootCooldown <= 0) {
        fireEnemyBullet(state, e, p.x, p.y);
        e.shootCooldown = 1.1 + rng.next() * 0.4;
      }
      if (d < 42 && e.meleeCooldown <= 0) {
        damagePlayer(state, ENEMY_MELEE_DAMAGE, 'melee');
        e.meleeCooldown = 0.8;
      }
    } else {
      // Too far to care: drift back toward the home spot.
      e.state = 'idle';
      const hd = dist(e.x, e.y, e.hx, e.hy);
      if (hd > 60) {
        const a = Math.atan2(e.hy - e.y, e.hx - e.x);
        e.angle = a;
        moveFighter(city, e, e.x + Math.cos(a) * 60 * dt, e.y + Math.sin(a) * 60 * dt);
      }
    }
    const c = clampToWorld(e.x, e.y, 16);
    e.x = c.x; e.y = c.y;
  }

  // --- mission guards (mission 5): stand post and shoot back ------------------
  for (const ped of state.peds) {
    if (!ped.missionGuard || ped.alive === false) continue;
    ped.shootCooldown = Math.max(0, (ped.shootCooldown ?? 0) - dt);
    const d = dist(ped.x, ped.y, p.x, p.y);
    if (d < 380) {
      ped.angle = Math.atan2(p.y - ped.y, p.x - ped.x);
      if (d < 320 && ped.shootCooldown <= 0) {
        fireEnemyBullet(state, ped, p.x, p.y);
        ped.shootCooldown = 1.2 + rng.next() * 0.5;
      }
    }
  }

  // --- pickups ------------------------------------------------------------------
  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const pk = state.pickups[i];
    if (dist(p.x, p.y, pk.x, pk.y) >= 28) continue;
    if (pk.kind === 'health') {
      healPlayer(state, 40);
      setToast(state, 'Kesehatan +40');
    } else {
      state.ammo = Math.min(AMMO_MAX, state.ammo + 24);
      setToast(state, 'Amunisi +24');
    }
    combatSound(state, playPickup);
    state.pickups.splice(i, 1);
  }

  // Wasted is also caught here in case health hit 0 outside damagePlayer.
  if (state.health <= 0 && state.mode === 'playing') {
    state.health = 0;
    state.mode = 'wasted';
    try { saveGame(state); } catch { /* saving never breaks the game */ }
  }
}
