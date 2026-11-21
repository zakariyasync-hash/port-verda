// rng.js — seeded random numbers for Port Verda.
// mulberry32: small, fast, deterministic PRNG. Same seed => same city,
// same traffic, same everything. Used by city generation, spawns and
// anything else that must be reproducible between runs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Create an rng object with named helpers bound to one stream.
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    // Float in [min, max).
    rand(min = 0, max = 1) {
      return min + next() * (max - min);
    },
    // Integer in [min, max] inclusive.
    randInt(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    // Random element of an array.
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    // True with probability p (0..1).
    chance(p) {
      return next() < p;
    },
    // In-place Fisher-Yates shuffle, returns the array.
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
  };
}

// Standalone helpers for code that already holds a next() function.
export function rand(rng, min = 0, max = 1) {
  return min + rng() * (max - min);
}

export function randInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function chance(rng, p) {
  return rng() < p;
}
