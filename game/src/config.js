// config.js — every tuning constant for Port Verda in one place.
// Other modules read CFG and never hard-code a magic number of their own.
export const CFG = {
  // World
  WORLD_W: 2560,
  WORLD_H: 1920,
  SEED: 20261121,
  SAVE_KEY: 'port-verda-save-v1',

  // City layout
  ROAD_W: 64, // asphalt width of every street and avenue
  SIDEWALK: 14, // pavement strip on each side of a road
  AVENUES: [160, 420, 680, 940, 1200, 1460, 1720, 1980, 2240],
  STREETS: [140, 380, 620, 860, 1100, 1340, 1560],
  PROMENADE_Y: 1680, // waterfront road along the harbour, south edge of the city
  WATER_Y: 1740, // everything at y >= WATER_Y is harbour water (except piers)

  // Player on foot
  WALK_SPEED: 175, // px per second
  PLAYER_RADIUS: 14,
  PLAYER_MAX_HEALTH: 100,

  // Cars
  CAR_W: 46,
  CAR_H: 24,
  CAR_ACCEL: 430, // px/s^2 forward
  CAR_REVERSE_ACCEL: 260,
  CAR_MAX_SPEED: 540,
  CAR_MAX_REVERSE: 190,
  CAR_BRAKE: 760,
  CAR_DRAG: 0.55, // per-second exponential drag when no input
  CAR_TURN: 2.7, // radians per second at full lock, scaled by speed
  CAR_BOOST_MULT: 1.35, // Shift while driving
  CAR_ENTER_DIST: 78, // how close the player must be to press E

  // Traffic and pedestrians
  TRAFFIC_COUNT: 12,
  TRAFFIC_SPEED: 185,
  TRAFFIC_MIN_GAP: 60,
  PED_COUNT: 16,
  PED_SPEED: 55,
  PED_RADIUS: 10,

  // Police and wanted level
  WANTED_MAX: 5,
  WANTED_DECAY_SECONDS: 18, // seconds with no crime before one star drops
  POLICE_CHASE_SPEED: 470,
  POLICE_RAM_DAMAGE: 22,
  POLICE_BUST_DIST: 42,
  POLICE_SPAWN_DIST: 520, // police spawn this far from the player, on a road
  CRIME_HEAT_PUNCH: 1, // wanted stars gained for punching a pedestrian
  CRIME_HEAT_SHOOT: 2, // wanted stars gained for shooting

  // Combat
  PUNCH_RANGE: 34,
  PUNCH_DAMAGE: 20,
  PUNCH_COOLDOWN: 0.45,
  SHOOT_RANGE: 320,
  SHOOT_COOLDOWN: 0.28,
  SHOOT_DAMAGE: 34,

  // Missions
  MISSION_ARRIVE_DIST: 64,

  // Camera, loop and HUD
  FIXED_DT: 1 / 60,
  CAMERA_LERP: 5.5,
  MINIMAP_W: 208,
  MINIMAP_H: 156,
  START_MONEY: 250,
  DAY_LENGTH_SECONDS: 480, // one full in-game day

  // District palettes (ground, building roof, accent)
  DISTRICTS: {
    downtown: { ground: '#8a8f7a', roof: '#5d6b7a', roofAlt: '#6e7f92', accent: '#3f4c5e', label: 'DOWNTOWN' },
    oldtown: { ground: '#9a8f78', roof: '#a8573f', roofAlt: '#b06a4a', accent: '#7c4a34', label: 'OLD TOWN' },
    market: { ground: '#93876f', roof: '#c98f3d', roofAlt: '#d9a44e', accent: '#8a6420', label: 'MARKET' },
    industrial: { ground: '#7d7a72', roof: '#6a6f75', roofAlt: '#7d838a', accent: '#4c4f55', label: 'INDUSTRIAL' },
    hills: { ground: '#7f9a6a', roof: '#7a5a3c', roofAlt: '#8a6a48', accent: '#5a4630', label: 'HILLS' },
    harbor: { ground: '#6f6a5e', roof: '#4e5a66', roofAlt: '#5b6a78', accent: '#37414d', label: 'HARBOR' },
  },
  WATER_COLOR: '#1d5f7a',
  WATER_DEEP: '#154a61',
  ROAD_COLOR: '#33363b',
  SIDEWALK_COLOR: '#9aa0a3',
  PARK_COLOR: '#4d8a4a',
  PARK_DARK: '#3c7039',
};
