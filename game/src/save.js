// save.js — persisting a Port Verda run in this browser's localStorage.
// Only plain progress is stored: position, money, health, the city seed,
// which missions are finished and which one is active. Nothing secret,
// nothing the game needs to phone home for.

import { CFG } from './config.js';

const KEY = CFG.SAVE_KEY;

export function hasSave() {
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function saveGame(state) {
  const data = {
    version: 1,
    savedAt: Date.now(),
    seed: state.seed ?? CFG.CITY_SEED,
    time: state.time || 0,
    money: state.money || 0,
    health: state.health ?? CFG.PLAYER_MAX_HEALTH,
    wanted: state.wanted || 0,
    player: {
      x: state.player.x,
      y: state.player.y,
      angle: state.player.angle || 0,
      onFoot: state.player.onFoot !== false,
      weapon: state.player.weapon || 'fists',
      ammo: state.player.ammo || 0,
    },
    missions: {
      completed: (state.missions && state.missions.completed) || [],
      current: (state.missions && state.missions.current) || null,
      active: (state.missions && state.missions.active && state.missions.active.id) || null,
    },
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// Returns the saved object, or null when there is no save / it is unreadable.
export function loadGame() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !data.player) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
