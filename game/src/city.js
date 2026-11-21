// city.js — Port Verda, a fictional harbour city, built from a seed.
// Layout: a full grid of avenues (north-south) and streets (east-west).
// Every avenue runs down to the waterfront promenade and every street
// runs the full width, so the road graph has no dead ends: a car driving
// south down any avenue reaches the promenade, turns, and loops back up.
// Warehouses sit between the harbour-front street and the promenade,
// with a road on every side. Water fills the south strip (y >= WATER_Y).
import { CFG } from './config.js';
import { createRng } from './rng.js';

const CORRIDOR = CFG.ROAD_W / 2 + CFG.SIDEWALK; // 46 px from a road centre to a block edge

// District of a point, from the six district rectangles.
export function districtAt(x, y) {
  if (y >= 1340) return 'harbor';
  if (y < 860) {
    if (x < 940) return 'oldtown';
    if (x < 1720) return 'downtown';
    return 'market';
  }
  if (x < 940) return 'industrial';
  if (x >= 1720) return 'hills';
  return 'downtown';
}

function blockIntervals(centres) {
  // centres: road centre lines; returns [start, end] of the buildable strip
  // between each pair of neighbouring roads (and the map edges).
  const bounds = [0, ...centres, centres === CFG.AVENUES ? CFG.WORLD_W : CFG.WORLD_H];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const x0 = a === 0 ? 0 : a + CORRIDOR;
    const x1 = b === (centres === CFG.AVENUES ? CFG.WORLD_W : CFG.WORLD_H) ? b : b - CORRIDOR;
    out.push([x0, x1]);
  }
  return out;
}

// How many buildings a block of this district holds.
function buildingCount(district, rng) {
  if (district === 'downtown') return rng.randInt(1, 2);
  if (district === 'oldtown') return rng.randInt(3, 4);
  if (district === 'market') return rng.randInt(2, 3);
  if (district === 'industrial') return rng.randInt(1, 2);
  if (district === 'hills') return rng.randInt(4, 6);
  return rng.randInt(1, 2); // harbor warehouses
}

function gridFor(count, w, h) {
  if (count <= 1) return [1, 1];
  if (count === 2) return w >= h ? [2, 1] : [1, 2];
  if (count === 3) return w >= h ? [3, 1] : [1, 3];
  if (count === 4) return [2, 2];
  return [3, 2];
}

export function buildCity(seed = CFG.SEED) {
  const rng = createRng(seed);
  const yRoads = [...CFG.STREETS, CFG.PROMENADE_Y];

  // --- road centre lines -------------------------------------------------
  const roads = [];
  for (const x of CFG.AVENUES) roads.push({ x1: x, y1: 0, x2: x, y2: CFG.PROMENADE_Y + CORRIDOR, vertical: true });
  for (const y of yRoads) roads.push({ x1: 0, y1: y, x2: CFG.WORLD_W, y2: y, vertical: false });

  // --- blocks ------------------------------------------------------------
  const xSpans = blockIntervals(CFG.AVENUES);
  const ySpans = blockIntervals(yRoads);
  const blocks = [];
  for (const [x0, x1] of xSpans) {
    for (const [y0, y1] of ySpans) {
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 40 || h < 40) continue; // quay strip and slivers are not buildable
      if (y0 >= CFG.PROMENADE_Y + CORRIDOR) continue; // south of the promenade is quay and water
      const cx = x0 + w / 2;
      const cy = y0 + h / 2;
      blocks.push({ x: x0, y: y0, w, h, district: districtAt(cx, cy) });
    }
  }

  // --- parks: six blocks become green space instead of buildings --------
  const parkable = blocks.filter((b) => b.w >= 110 && b.h >= 100 && b.district !== 'harbor' && b.district !== 'industrial');
  rng.shuffle(parkable);
  const parks = parkable.slice(0, 6).map((b) => {
    const trees = [];
    const n = rng.randInt(8, 14);
    for (let i = 0; i < n; i++) {
      trees.push({ x: b.x + rng.rand(14, b.w - 14), y: b.y + rng.rand(14, b.h - 14), r: rng.rand(5, 9) });
    }
    return { x: b.x, y: b.y, w: b.w, h: b.h, district: b.district, trees };
  });
  const parkSet = new Set(parks.map((p) => `${p.x},${p.y}`));

  // --- buildings ---------------------------------------------------------
  const buildings = [];
  for (const b of blocks) {
    if (parkSet.has(`${b.x},${b.y}`)) continue;
    const pal = CFG.DISTRICTS[b.district];
    const count = buildingCount(b.district, rng);
    const [cols, rows] = gridFor(count, b.w, b.h);
    const cellW = b.w / cols;
    const cellH = b.h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inset = rng.rand(6, 12);
        const bx = b.x + c * cellW + inset;
        const by = b.y + r * cellH + inset;
        const bw = cellW - inset * 2;
        const bh = cellH - inset * 2;
        if (bw < 24 || bh < 24) continue;
        const height = b.district === 'downtown' ? 3 : b.district === 'market' && rng.chance(0.4) ? 2 : 1;
        buildings.push({
          x: bx, y: by, w: bw, h: bh,
          district: b.district, height,
          color: rng.chance(0.5) ? pal.roof : pal.roofAlt,
          accent: pal.accent,
        });
      }
    }
  }

  // --- harbour: piers, ships, cranes, quay containers --------------------
  const piers = [320, 860, 1420, 1980].map((x) => ({ x: x - 28, y: CFG.PROMENADE_Y + CORRIDOR, w: 56, h: 144 }));
  const ships = [
    { x: 480, y: 1816, w: 230, h: 42, angle: 0.04 },
    { x: 1760, y: 1796, w: 270, h: 46, angle: -0.03 },
  ];
  const cranes = piers.slice(0, 3).map((p) => ({ x: p.x + p.w + 26, y: CFG.PROMENADE_Y + 8 }));
  const containers = [];
  for (const [x0, x1] of xSpans) {
    const y0 = CFG.STREETS[CFG.STREETS.length - 1] + CORRIDOR; // quay strip
    const y1 = CFG.PROMENADE_Y - CORRIDOR;
    if (y1 - y0 < 20) continue;
    let x = x0 + 8;
    while (x + 44 < x1) {
      if (rng.chance(0.6)) {
        containers.push({
          x, y: y0 + 4, w: 40, h: 20,
          color: rng.pick(['#b3543f', '#3f7ab5', '#c98f3d', '#4d8a4a', '#7a5a8a']),
        });
      }
      x += 48;
    }
  }

  // --- road graph: one node per intersection, edges to neighbours --------
  const nodes = [];
  const adj = new Map();
  const nodeId = (ix, iy) => iy * CFG.AVENUES.length + ix;
  for (let iy = 0; iy < yRoads.length; iy++) {
    for (let ix = 0; ix < CFG.AVENUES.length; ix++) {
      const id = nodeId(ix, iy);
      nodes.push({ id, x: CFG.AVENUES[ix], y: yRoads[iy], ix, iy });
      const neighbours = [];
      if (ix > 0) neighbours.push(nodeId(ix - 1, iy));
      if (ix < CFG.AVENUES.length - 1) neighbours.push(nodeId(ix + 1, iy));
      if (iy > 0) neighbours.push(nodeId(ix, iy - 1));
      if (iy < yRoads.length - 1) neighbours.push(nodeId(ix, iy + 1));
      adj.set(id, neighbours);
    }
  }
  const roadGraph = { nodes, adj, nodeId };

  // --- districts (for ground tint and labels) ---------------------------
  const districts = [
    { key: 'oldtown', x: 0, y: 0, w: 940, h: 860 },
    { key: 'downtown', x: 940, y: 0, w: 780, h: 1340 },
    { key: 'market', x: 1720, y: 0, w: 840, h: 860 },
    { key: 'industrial', x: 0, y: 860, w: 940, h: 480 },
    { key: 'hills', x: 1720, y: 860, w: 840, h: 480 },
    { key: 'harbor', x: 0, y: 1340, w: 2560, h: 400 },
  ];

  // --- spawns ------------------------------------------------------------
  const carSpots = [];
  for (let i = 0; i < 8; i++) {
    const p = randomRoadPointOn(roads, rng);
    carSpots.push({ x: p.x, y: p.y, angle: p.angle });
  }
  const spawns = {
    player: { x: 1200, y: 860 },
    policeStation: { x: 1460, y: 380 },
    hospital: { x: 680, y: 1100 },
    cars: carSpots,
    missionSpots: [
      { id: 'dermaga', name: 'Dermaga 3', x: 320, y: 1700 },
      { id: 'pasar', name: 'Pasar Ikan', x: 1980, y: 620 },
      { id: 'gudang', name: 'Gudang 7', x: 420, y: 1560 },
      { id: 'menara', name: 'Menara Kembar', x: 1200, y: 380 },
      { id: 'bengkel', name: 'Bengkel Tua', x: 680, y: 1100 },
      { id: 'bukit', name: 'Bukit Perumahan', x: 2240, y: 1100 },
      { id: 'kantor', name: 'Kantor Polisi', x: 1460, y: 380 },
      { id: 'pintu', name: 'Pintu Pelabuhan', x: 940, y: 1560 },
    ],
  };

  const city = {
    seed, roads, blocks, buildings, parks, districts,
    water: { y0: CFG.WATER_Y, y1: CFG.WORLD_H },
    piers, ships, cranes, containers, roadGraph, spawns,
  };

  // Bound helpers to this city so callers can use city.isRoad(x, y) etc.
  city.isRoad = (x, y) => isRoad(city, x, y);
  city.collidesBuilding = (x, y, r) => collidesBuilding(city, x, y, r);
  city.isWater = (x, y) => isWater(city, x, y);
  city.clampToWorld = (x, y, r) => clampToWorld(x, y, r);
  city.randomRoadPoint = (r) => randomRoadPoint(city, r);
  city.nearestRoad = (x, y) => nearestRoad(city, x, y);
  return city;
}

// --- queries (pure functions of a city) -----------------------------------

export function isRoad(city, x, y) {
  for (const ax of CFG.AVENUES) {
    if (Math.abs(x - ax) <= CFG.ROAD_W / 2 && y >= 0 && y <= CFG.PROMENADE_Y + CORRIDOR) return true;
  }
  for (const sy of [...CFG.STREETS, CFG.PROMENADE_Y]) {
    if (Math.abs(y - sy) <= CFG.ROAD_W / 2 && x >= 0 && x <= CFG.WORLD_W) return true;
  }
  return false;
}

export function collidesBuilding(city, x, y, r = 0) {
  for (const b of city.buildings) {
    if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return b;
  }
  return null;
}

export function isWater(city, x, y) {
  if (y < CFG.WATER_Y) return false;
  for (const p of city.piers) {
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return false;
  }
  return true;
}

export function clampToWorld(x, y, r = 0) {
  return {
    x: Math.min(Math.max(x, r), CFG.WORLD_W - r),
    y: Math.min(Math.max(y, r), CFG.WORLD_H - r),
  };
}

function randomRoadPointOn(roads, rng) {
  const road = rng.pick(roads);
  if (road.vertical) {
    return { x: road.x1, y: rng.rand(road.y1 + 40, road.y2 - 40), angle: Math.PI / 2 };
  }
  return { x: rng.rand(road.x1 + 40, road.x2 - 40), y: road.y1, angle: 0 };
}

export function randomRoadPoint(city, rng) {
  return randomRoadPointOn(city.roads, rng);
}

export function nearestRoad(city, x, y) {
  let best = null;
  for (const road of city.roads) {
    let px;
    let py;
    if (road.vertical) {
      px = road.x1;
      py = Math.min(Math.max(y, road.y1), road.y2);
    } else {
      px = Math.min(Math.max(x, road.x1), road.x2);
      py = road.y1;
    }
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.dist) {
      best = { x: px, y: py, dist: d, angle: road.vertical ? Math.PI / 2 : 0, vertical: road.vertical };
    }
  }
  return best;
}
