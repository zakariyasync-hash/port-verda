// Player locomotion adapter (B4 integration).
// main.js calls mods.player.updatePlayer(state, dt, input) when this module
// loads; the driving and walking implementations live in vehicles.js (B2).
// This file stays thin on purpose: one canonical implementation, no copy.
// Without this file the game fell back to fallbackPlayer in main.js AND
// logged a 404 console error for the missing module on every load.
import { updatePlayerCar, updatePlayerOnFoot } from './vehicles.js';

export function updatePlayer(state, dt, input) {
  if (!state || !state.player) return;
  if (state.player.inCar) updatePlayerCar(state, dt, input);
  else updatePlayerOnFoot(state, dt, input);
}
