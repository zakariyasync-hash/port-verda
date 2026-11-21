// save.js — save / load through localStorage, key 'port-verda-save-v1'.
// Only plain progress is stored: position, money, health, finished
// missions, wanted level and clock. No functions, no live entities:
// cars, traffic, pedestrians and police are rebuilt from the seed on load.
import { CFG } from './config.js';

// localStorage may be missing (Node tests) or refused (private windows).
const memoryFallback = {};
const store = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // fall through to the in-memory store
  }
  return {
    getItem: (k) => (k in memoryFallback ? memoryFallback[k] : null),
    setItem: (k, v) => { memoryFallback[k] = String(v); },
    removeItem: (k) => { delete memoryFallback[k]; },
  };
})();

export function saveGame(state) {
  const data = {
    version: 1,
    savedAt: Date.now(),
    x: Math.round(state.player.x),
    y: Math.round(state.player.y),
    money: state.money,
    health: state.health,
    wanted: state.wanted,
    time: state.time,
    missionsDone: [...state.missions.done],
    activeMission: state.missions.activeId,
  };
  try {
    store.setItem(CFG.SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function loadGame() {
  let raw = null;
  try {
    raw = store.getItem(CFG.SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1) return null;
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return null;
    return {
      x: data.x,
      y: data.y,
      money: typeof data.money === 'number' ? data.money : CFG.START_MONEY,
      health: typeof data.health === 'number' ? data.health : CFG.PLAYER_MAX_HEALTH,
      wanted: typeof data.wanted === 'number' ? data.wanted : 0,
      time: typeof data.time === 'number' ? data.time : 0,
      missionsDone: Array.isArray(data.missionsDone) ? data.missionsDone : [],
      activeMission: typeof data.activeMission === 'string' ? data.activeMission : null,
    };
  } catch {
    return null;
  }
}

export function hasSave() {
  try {
    return store.getItem(CFG.SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    store.removeItem(CFG.SAVE_KEY);
  } catch {
    // nothing to clear
  }
}
