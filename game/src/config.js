// config.js — satu-satunya sumber angka tuning Port Verda.
//
// Semua modul membaca dari CFG ini: dunia, kota, jalan kaki, mengemudi,
// lalu lintas, pejalan kaki, polisi/wanted, dan combat. Nilai-nilainya
// adalah nilai yang benar-benar dipakai modul update (B2): saat ada
// selisih dengan tebakan awal B1, nilai modul yang sedang berjalan yang
// dipakai, supaya perilaku game tidak berubah saat konstanta dipindah.
//
// Reward misi TIDAK ada di sini — angkanya hidup di missions.js
// (m1 $50, m2 $120, m3 $200, m4 $250, m5 $400, m6 $600, side $90/$150)
// dan itulah yang berlaku. Semua jarak dalam piksel dunia, semua
// kecepatan dalam piksel per detik, kecuali dinyatakan lain.

export const CFG = {
  // Dunia
  WORLD_W: 3200,
  WORLD_H: 2400,
  CITY_SEED: 20261121,
  SAVE_KEY: 'port-verda-save-v1',

  // Tata kota
  ROAD_SPACING: 200,
  ROAD_WIDTH: 26,
  BLOCK_MARGIN: 14,
  HARBOR_WATER_TOP: 2100, // y di atas ini adalah air (WORLD_H - 300)
  HARBOR_STRIP_TOP: 1800, // y di atas ini adalah distrik Harbor
  HARBOR_DOCKS: 6, // dermaga kayu di sepanjang tepi air

  // Pemain jalan kaki
  WALK_SPEED: 190,
  RUN_SPEED: 285,
  PLAYER_RADIUS: 13,
  PLAYER_MAX_HEALTH: 100,

  // Mengemudi (mobil pemain)
  CAR_ACCEL: 430, // px/s^2, gas maju
  CAR_REVERSE_ACCEL: 280, // px/s^2, mundur
  CAR_BRAKE: 700, // px/s^2, rem saat melaju ke arah berlawanan
  CAR_HANDBRAKE: 950, // px/s^2, rem tangan (Shift)
  CAR_DRAG: 0.55, // gesekan gelinding, per detik
  CAR_MAX_SPEED: 540, // px/s maju
  CAR_MAX_REVERSE: 180, // px/s mundur
  CAR_TURN_BASE: 2.9, // rad/s pada kecepatan sedang
  CAR_TURN_MIN_SPEED: 150, // kecepatan untuk setir penuh
  HANDBRAKE_TURN_BONUS: 1.45, // pengali setir saat rem tangan
  CAR_RADIUS: 16, // radius tabrakan mobil
  ENTER_RADIUS: 78, // jarak maksimum untuk masuk mobil
  EXIT_OFFSET: 30, // jarak pemain muncul di samping mobil
  CAR_HEALTH: 100,

  // Lalu lintas
  TRAFFIC_COUNT: 14, // mobil lalu lintas yang hidup
  PARKED_COUNT: 10, // mobil parkir di tepi jalan
  TRAFFIC_SPAWN_SPEED: 0, // mobil lalu lintas mulai dari diam lalu berakselerasi (bukan muncul melaju 140+ px/dtk di atas pejalan kaki)
  TRAFFIC_SPEED_MIN: 140,
  TRAFFIC_SPEED_MAX: 215,
  TRAFFIC_ACCEL: 220, // px/s^2
  JUNCTION_SLOW_DIST: 95, // mulai melambat sejauh ini dari simpang
  JUNCTION_SLOW_SPEED: 85, // batas kecepatan di dekat simpang
  FOLLOW_DIST: 72, // jarak mulai mengerem di belakang mobil lain
  FOLLOW_STOP_DIST: 40, // jarak berhenti penuh di belakang mobil lain
  NODE_ARRIVE_DIST: 30, // jarak dianggap sampai di node tujuan

  // Pejalan kaki
  PED_COUNT: 26, // jumlah pejalan kaki yang dijaga hidup
  PED_SPEED_MIN: 42,
  PED_SPEED_MAX: 72,
  PED_RADIUS: 12,
  FLEE_SPEED: 175, // px/s saat lari ketakutan
  SIDEWALK_OFFSET: 30, // jarak pejalan kaki dari garis tengah jalan
  FLEE_RADIUS: 340, // radius dengar tembakan
  FLEE_TIME: 3.2, // detik lari sebelum tenang kembali
  CAR_SCARE_DIST: 64, // mobil secepat ini & sedekat ini bikin lari
  CAR_SCARE_SPEED: 200, // px/s
  HIT_DIST: 22, // jarak mobil-ped dianggap tabrakan
  HIT_SPEED: 90, // kecepatan mobil minimum agar tabrakan dihitung
  HIT_DAMAGE: 50, // damage ke pejalan kaki saat tertabrak
  HIT_CRIME_COOLDOWN: 5, // detik antar kenaikan wanted per pejalan kaki
  PED_HEALTH: 100,
  DOWN_DESPAWN: 6, // detik pejalan kaki terkapar sebelum hilang
  IDLE_CHANCE: 0.25, // peluang berhenti sejenak di ujung ruas
  IDLE_TIME_MIN: 1.5, // detik diam
  IDLE_TIME_MAX: 4, // detik diam
  RESPAWN_MIN_DIST: 500, // respawn minimal sejauh ini dari pemain

  // Polisi / wanted
  WANTED_MAX: 5,
  DECAY_IDLE: 18, // detik tanpa kriminal sebelum wanted luruh
  DECAY_INTERVAL: 14, // detik per satu bintang yang luruh
  DECAY_SAFE_DIST: 700, // wanted hanya luruh bila polisi sejauh ini
  BUST_TIME: 3.0, // detik dekat + lambat sampai tertangkap
  BUST_DIST: 48, // jarak polisi-pemain untuk bust
  BUST_SPEED: 60, // kecepatan pemain maksimum agar bust jalan
  SPAWN_DIST: 560, // jarak spawn polisi dari pemain (tepi layar)
  DESPAWN_DIST: 1400, // polisi sejauh ini saat wanted 0 dihapus
  PATROL_COUNT: 1, // mobil patroli saat wanted 0
  CHASE_COUNT_PER_STAR: 1, // mobil pengejar per bintang wanted
  MAX_CHASE_CARS: 4, // batas mobil polisi pengejar
  PATROL_SPEED: 150, // px/s
  CHASE_SPEED_BASE: 380, // px/s
  CHASE_SPEED_PER_STAR: 28, // px/s tambahan per bintang
  CHASE_MAX_SPEED: 560, // px/s
  POLICE_TURN: 3.4, // rad/s saat mengejar
  POLICE_ACCEL: 420, // px/s^2
  RAM_DIST: 36, // jarak tabrakan ram
  RAM_DAMAGE: 6, // damage ke mobil pemain per ram
  RAM_SLOW: 0.6, // pengali kecepatan mobil pemain saat di-ram
  DISABLE_TIME: 8, // detik mobil polisi rusak sebelum ditarik
  POLICE_CAR_HEALTH: 100,

  // Combat
  PUNCH_RANGE: 54, // jangkauan pukulan
  PUNCH_DAMAGE: 34, // damage per pukulan
  PUNCH_COOLDOWN: 0.45, // detik antar pukulan
  BULLET_SPEED: 950, // px/s
  BULLET_LIFE: 0.9, // detik umur peluru
  BULLET_DAMAGE: 34, // damage per peluru
  BULLET_HIT_PED: 16, // radius kena pejalan kaki
  BULLET_HIT_CAR: 22, // radius kena mobil
  BULLET_SPREAD: 0.03, // radian sebaran acak arah tembakan
  PISTOL_AMMO_START: 24, // peluru awal pemain
  HEALTH_PACK_INTERVAL: 40, // detik antar spawn health pack
  HEALTH_PACK_MAX: 2, // health pack maksimum yang hidup bersamaan
  HEALTH_PACK_HEAL: 25, // health yang dipulihkan
  PICKUP_RADIUS: 32, // jarak ambil health pack

  // Ekonomi
  START_MONEY: 150,

  // Kamera / tampilan
  CAMERA_LERP: 6,
  MINIMAP_W: 190,
  MINIMAP_H: 142,
  MINIMAP_MARGIN: 14,

  // Warna (satu sumber kebenaran untuk palet)
  COLORS: {
    ground: '#8a7f63',
    groundDry: '#8f8468',
    water: '#1d6f8e',
    waterDeep: '#155a75',
    road: '#3c3f45',
    roadEdge: '#2c2f34',
    roadLine: '#d8c95a',
    sidewalk: '#6f6a5e',
    park: '#4d7a3f',
    parkDark: '#3e6534',
    buildingRoof: '#b08954',
    buildingRoof2: '#7d8aa0',
    buildingRoof3: '#9c6b4f',
    buildingRoof4: '#5f7d6a',
    buildingWall: '#5a5348',
    harborConcrete: '#7a756a',
    dockWood: '#8a6b45',
    containers: ['#c9502e', '#2e7d9c', '#d9a441', '#5d8a4a', '#7a5a9c'],
  },
};
