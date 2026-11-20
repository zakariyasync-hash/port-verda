// rng.js — deterministic seeded random helpers for Port Verda.
// Everything in the world generator draws from one mulberry32 stream so a
// city built from the same seed is byte-for-byte the same city every time.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Float in [min, max).
export function rand(rng, min, max) {
  return min + rng() * (max - min);
}

// Integer in [min, max] inclusive.
export function randInt(rng, min, max) {
  return Math.floor(rand(rng, min, max + 1));
}

// One element of an array, uniformly.
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// True with probability p (0..1).
export function chance(rng, p) {
  return rng() < p;
}

// In-place Fisher-Yates shuffle, returns the same array.
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// Pick one element with weights: items[i] is chosen with probability
// weights[i] / sum(weights). Weights must be non-negative, at least one > 0.
export function pickWeighted(rng, items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

// A small gaussian-ish value centred on 0, in roughly [-1, 1].
export function bell(rng) {
  return (rng() + rng() + rng() - 1.5) / 1.5;
}
