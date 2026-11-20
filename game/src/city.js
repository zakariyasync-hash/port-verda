// city.js — builds Port Verda: a fictional harbour city on a 3200x2400
// world. A regular road grid, six districts, buildings tucked inside the
// blocks (never on a road), parks, a harbour waterfront with open water
// along the whole south edge, a road graph for traffic, and spawn points.
// Deterministic: the same seed always builds the same city.
//
// The module keeps the most recently built city as the "active" city, and
// the query helpers (isRoad / collidesBuilding / pointInWater) answer
// against it, so the update modules can call them with just a point.

import { CFG } from './config.js';
import { mulberry32, rand, randInt, pick, chance, shuffle } from './rng.js';

let activeCity = null;

const DISTRICTS = ['Harbor', 'Downtown', 'Old Town', 'Market', 'Industrial', 'Hills'];

const ROOFS = ['buildingRoof', 'buildingRoof2', 'buildingRoof3', 'buildingRoof4'];

// Decide which district a block centre belongs to, by geography.
function districtAt(cx, cy) {
  if (cy >= CFG.HARBOR_STRIP_TOP) return 'Harbor';
  if (cx >= 2400) return 'Industrial';
  if (cy <= 600 && cx >= 2000) return 'Hills';
  if (cx >= 1200 && cx <= 2200 && cy >= 600 && cy <= 1400) return 'Downtown';
  if (cx <= 1000 && cy <= 1000) return 'Old Town';
  if (cy >= 1400 && cx >= 800 && cx <= 1800) return 'Market';
  // Fringe blocks fall back to the nearest flavour by position.
  if (cy <= 800) return 'Old Town';
  if (cx >= 2200) return 'Industrial';
  return 'Market';
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function buildCity(seed) {
  const rng = mulberry32(seed);
  const { WORLD_W, WORLD_H, ROAD_SPACING, ROAD_WIDTH, BLOCK_MARGIN } = CFG;
  const halfRoad = ROAD_WIDTH / 2;

  // --- Roads: a grid every ROAD_SPACING px, inset half a spacing from the
  // edges so there is always a border block. Horizontal roads stop above
  // the harbour strip; the waterfront road at y=2000 is the last one.
  const roads = [];
  const vLines = [];
  for (let x = ROAD_SPACING; x < WORLD_W; x += ROAD_SPACING) {
    vLines.push(x);
    roads.push({ x1: x, y1: 0, x2: x, y2: CFG.HARBOR_STRIP_TOP, width: ROAD_WIDTH, dir: 'v' });
  }
  const hLines = [];
  for (let y = ROAD_SPACING; y < CFG.HARBOR_STRIP_TOP; y += ROAD_SPACING) {
    hLines.push(y);
    roads.push({ x1: 0, y1: y, x2: WORLD_W, y2: y, width: ROAD_WIDTH, dir: 'h' });
  }
  // The harbour front road runs along the top of the docks.
  roads.push({ x1: 0, y1: CFG.HARBOR_STRIP_TOP, x2: WORLD_W, y2: CFG.HARBOR_STRIP_TOP, width: ROAD_WIDTH + 10, dir: 'h' });
  hLines.push(CFG.HARBOR_STRIP_TOP);

  // --- Blocks: the rectangles between neighbouring roads.
  const blocks = [];
  const xBounds = [0, ...vLines, WORLD_W];
  const yBounds = [0, ...hLines, CFG.HARBOR_STRIP_TOP];
  for (let i = 0; i < xBounds.length - 1; i++) {
    for (let j = 0; j < yBounds.length - 1; j++) {
      const bx = xBounds[i] + halfRoad + BLOCK_MARGIN;
      const by = yBounds[j] + halfRoad + BLOCK_MARGIN;
      const bw = xBounds[i + 1] - xBounds[i] - ROAD_WIDTH - BLOCK_MARGIN * 2;
      const bh = yBounds[j + 1] - yBounds[j] - ROAD_WIDTH - BLOCK_MARGIN * 2;
      if (bw < 30 || bh < 30) continue;
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      blocks.push({ x: bx, y: by, w: bw, h: bh, district: districtAt(cx, cy), park: false });
    }
  }
  // --- The harbour strip below the front road is split into four dock
  // blocks, so the waterfront gets several warehouses instead of one.
  const harborBlockW = (WORLD_W - ROAD_WIDTH - BLOCK_MARGIN * 2) / 4;
  for (let s = 0; s < 4; s++) {
    blocks.push({
      x: halfRoad + BLOCK_MARGIN + s * harborBlockW,
      y: CFG.HARBOR_STRIP_TOP + halfRoad + 6,
      w: harborBlockW - 8,
      h: CFG.HARBOR_WATER_TOP - CFG.HARBOR_STRIP_TOP - halfRoad - 26,
      district: 'Harbor',
      park: false,
    });
  }

  // --- Parks: a few inland blocks become green squares.
  const parkCandidates = blocks.filter(
    (b) => b.district !== 'Harbor' && b.district !== 'Industrial' && b.w > 90 && b.h > 90,
  );
  shuffle(rng, parkCandidates);
  const parks = [];
  for (const b of parkCandidates.slice(0, 7)) {
    b.park = true;
    parks.push({ x: b.x, y: b.y, w: b.w, h: b.h, district: b.district });
  }

  // --- Buildings: 1-4 per block, placed inside the block with a gap
  // between them, never touching a road. Harbour blocks get long low
  // warehouses; Downtown gets tall slabs; Hills gets small houses.
  const buildings = [];
  for (const b of blocks) {
    if (b.park) continue;
    const d = b.district;
    let count;
    if (d === 'Harbor') count = randInt(rng, 2, 3);
    else if (d === 'Downtown') count = randInt(rng, 2, 3);
    else if (d === 'Hills') count = randInt(rng, 2, 4);
    else count = randInt(rng, 1, 3);
    let tries = 0;
    let placed = 0;
    while (placed < count && tries < 40) {
      tries++;
      let w;
      let h;
      if (d === 'Harbor') {
        w = rand(rng, 130, 210);
        h = rand(rng, 46, 70);
      } else if (d === 'Downtown') {
        w = rand(rng, 70, 110);
        h = rand(rng, 70, 120);
      } else if (d === 'Hills') {
        w = rand(rng, 34, 52);
        h = rand(rng, 30, 46);
      } else {
        w = rand(rng, 48, 96);
        h = rand(rng, 44, 88);
      }
      const x = rand(rng, b.x + 4, b.x + b.w - w - 4);
      const y = rand(rng, b.y + 4, b.y + b.h - h - 4);
      if (x < b.x || y < b.y) continue;
      const cand = { x, y, w, h, district: d, shade: rand(rng, 0.82, 1.08) };
      if (buildings.some((o) => rectsOverlap(o, { x: x - 6, y: y - 6, w: w + 12, h: h + 12 }))) continue;
      cand.roof = pick(rng, ROOFS);
      cand.tall = d === 'Downtown' ? randInt(rng, 2, 5) : d === 'Harbor' ? 1 : randInt(rng, 1, 2);
      buildings.push(cand);
      placed++;
    }
  }

  // --- Water: the whole south edge below the harbour, plus a small basin
  // cut into the docks so boats have somewhere to sit.
  const water = [
    { x: 0, y: CFG.HARBOR_WATER_TOP, w: WORLD_W, h: WORLD_H - CFG.HARBOR_WATER_TOP },
    { x: 2350, y: 1860, w: 420, h: 240 },
  ];

  // --- Road graph: a node at every grid intersection, edges along roads.
  const nodes = [];
  const nodeId = new Map();
  const key = (x, y) => x + ',' + y;
  for (const x of vLines) {
    for (const y of hLines) {
      const id = nodes.length;
      nodeId.set(key(x, y), id);
      nodes.push({ id, x, y });
    }
  }
  const edges = [];
  for (const x of vLines) {
    for (let j = 0; j + 1 < hLines.length; j++) {
      edges.push({ a: nodeId.get(key(x, hLines[j])), b: nodeId.get(key(x, hLines[j + 1])) });
    }
  }
  for (const y of hLines) {
    for (let i = 0; i + 1 < vLines.length; i++) {
      edges.push({ a: nodeId.get(key(vLines[i], y)), b: nodeId.get(key(vLines[i + 1], y)) });
    }
  }
  const roadGraph = { nodes, edges };

  // --- Spawns: the player starts on foot at the Market/Harbor corner,
  // cars sit on roads around the city, mission spots are fixed landmarks.
  const carSpots = [];
  for (let i = 0; i < 40; i++) {
    if (chance(rng, 0.5)) {
      // Mobil di jalan vertikal (x = garis vertikal): menghadap utara/selatan.
      carSpots.push({ x: pick(rng, vLines) + rand(rng, -6, 6), y: rand(rng, 120, 1780), angle: chance(rng, 0.5) ? Math.PI / 2 : -Math.PI / 2 });
    } else {
      // Mobil di jalan horizontal (y = garis horizontal): menghadap timur/barat.
      carSpots.push({ x: rand(rng, 120, WORLD_W - 120), y: pick(rng, hLines) + rand(rng, -6, 6), angle: chance(rng, 0.5) ? 0 : Math.PI });
    }
  }
  const spawns = {
    player: { x: 1000, y: 1700 },
    cars: carSpots.slice(0, 24),
    missionSpots: {
      mira: { x: 1000, y: 1700, label: 'Mira — fixer' },
      harbor: { x: 600, y: 1900, label: 'Dermaga 7' },
      market: { x: 1400, y: 1500, label: 'Pasar Ikan' },
      downtown: { x: 1700, y: 1000, label: 'Menara Kencana' },
      industrial: { x: 2700, y: 1200, label: 'Gudang Timur' },
      hills: { x: 2500, y: 400, label: 'Bukit Melati' },
    },
  };

  const city = { seed, roads, blocks, buildings, parks, water, spawns, roadGraph };
  activeCity = city;
  // Tempelkan query helper sebagai method kota, supaya modul update
  // (vehicles/peds/police/combat) dan main.js bisa memanggil
  // city.collidesBuilding / city.pointInWater / city.isRoad langsung.
  // Tanpa ini usableCity() di modul-modul itu jatuh ke kota darurat
  // (grid 5x4) dan lalu lintas/polisi berjalan di luar kota asli —
  // dan gerak jalan kaki melempar TypeError tiap frame.
  city.isRoad = (x, y) => isRoad(x, y);
  city.collidesBuilding = (x, y, r) => collidesBuilding(x, y, r);
  city.pointInWater = (x, y) => pointInWater(x, y);
  city.nearestNode = (x, y) => nearestNode(x, y);
  return city;
}

export function getCity() {
  return activeCity;
}

// Is the point on a road (within half the road width)?
export function isRoad(x, y) {
  if (!activeCity) return false;
  for (const r of activeCity.roads) {
    const half = r.width / 2;
    if (r.dir === 'h') {
      if (Math.abs(y - r.y1) <= half && x >= r.x1 && x <= r.x2) return true;
    } else if (Math.abs(x - r.x1) <= half && y >= r.y1 && y <= r.y2) {
      return true;
    }
  }
  return false;
}

// Does a circle of radius r at (x, y) touch any building?
export function collidesBuilding(x, y, r) {
  if (!activeCity) return false;
  for (const b of activeCity.buildings) {
    const nx = Math.max(b.x, Math.min(x, b.x + b.w));
    const ny = Math.max(b.y, Math.min(y, b.y + b.h));
    const dx = x - nx;
    const dy = y - ny;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

// Is the point in open water?
export function pointInWater(x, y) {
  if (!activeCity) return y >= CFG.HARBOR_WATER_TOP;
  for (const w of activeCity.water) {
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return true;
  }
  return false;
}

// Nearest road-graph node to a point (for traffic routing).
export function nearestNode(x, y) {
  if (!activeCity) return null;
  let best = null;
  let bestD = Infinity;
  for (const n of activeCity.roadGraph.nodes) {
    const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

export { DISTRICTS };
