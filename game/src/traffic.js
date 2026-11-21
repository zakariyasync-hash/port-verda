// traffic.js — Port Verda traffic wiring (Builder B2).
//
// Thin adapter, no logic of its own: main.js step 3 calls
// updateTraffic(state, dt) from this module, and the traffic AI itself
// lives in vehicles.js (spawnTraffic / updateTraffic), where the B2 brief
// puts it. Re-exporting keeps one implementation and one set of tests.

export { spawnTraffic, updateTraffic } from './vehicles.js';
