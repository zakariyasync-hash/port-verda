// missions.js — Port Verda: daftar misi cerita + side job dan mesin progresinya.
//
// Modul ini HANYA mengurus data dan logika misi: memulai misi, memeriksa
// syarat selesai / gagal setiap frame, memberi reward, dan membuka misi
// berikutnya. Modul ini tidak menggambar apa pun dan tidak memutar suara:
// penyelesaian / kegagalan dilaporkan lewat nilai kembalian updateMissions
// dan lewat state.flags, supaya main.js yang memutuskan efek lanjutannya
// (jingle, popup, dan sebagainya).
//
// Kontrak state yang dipakai di sini:
//   state.player  { x, y, ... }
//   state.money   number
//   state.health  number
//   state.wanted  number (0..5)
//   state.cars    array mobil { id, model, isTarget, health, wrecked, ... }
//   state.peds    array pejalan kaki { gang, dead, health, ... }
//   state.city    objek kota B1 bila ada (dipakai untuk city.spawns.missionSpots)
//   state.missions { current, list, active }
//   state.flags   objek bebas untuk penanda antar modul

export const WORLD_W = 3200;
export const WORLD_H = 2400;

// Jarak (piksel dunia) yang dianggap "sampai" di titik target misi.
export const ARRIVE_RADIUS = 75;

// Titik-titik penting di peta Port Verda. Koordinat ini mengikuti kota B1
// (city.js): jalan-jalan berada di kelipatan 200 px, air mulai y=2100,
// dermaga di (600,1900). Titik yang punya padanan di
// city.spawns.missionSpots memakai koordinat B1 (lihat SPOT_ALIASES);
// sisanya diletakkan TEPAT di persimpangan jalan (kelipatan 200) supaya
// selalu bisa dicapai jalan kaki / mobil dan tidak jatuh di dalam gedung
// atau di air. B4 HARUS memverifikasi ulang bila city.js berubah.
export const MISSION_SPOTS = {
  depot: { x: 1000, y: 1700 }, // markas kurir Raka = spot 'mira' B1
  market: { x: 1400, y: 1500 }, // kios Pasar Verda = spot 'market' B1
  warehouseEast: { x: 2700, y: 1200 }, // gudang timur = spot 'industrial' B1
  downtown: { x: 1700, y: 1000 }, // alun-alun Downtown = spot 'downtown' B1
  oldTown: { x: 600, y: 1600 }, // gang Kota Tua (persimpangan jalan)
  pier: { x: 600, y: 1900 }, // dermaga selatan = spot 'harbor' B1
  garage: { x: 2400, y: 1000 }, // Bengkel Darto (persimpangan jalan)
  hills: { x: 2500, y: 400 }, // perumahan Bukit = spot 'hills' B1
  harborGate: { x: 1200, y: 1800 }, // terminal penumpang (jalan tepi dermaga)
  targetCar: { x: 2000, y: 1200 }, // tempat parkir bukit (persimpangan jalan)
};

// Nama spot lokal -> nama spot di city.spawns.missionSpots (B1). Bila kota
// menyediakan titik bernama itu, koordinat B1 yang dipakai.
export const SPOT_ALIASES = {
  depot: 'mira',
  warehouseEast: 'industrial',
  pier: 'harbor',
};

// ---------------------------------------------------------------------------
// Definisi misi
// ---------------------------------------------------------------------------
// Tiap entri: id, kind ('story' | 'side'), title, brief, objective, reward,
// spot (nama titik di MISSION_SPOTS), target (salinan koordinat spot),
// state ('locked' | 'active' | 'done' | 'failed'), plus field khusus:
//   timeLimit   detik (misi berwaktu)
//   points      daftar nama spot berurutan (misi multi-titik)
//   targetCarId / targetCarModel  (misi curi mobil)
// Field runtime (diisi startMission): phase, elapsed, timer, progress.

function baseMission(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    brief: entry.brief,
    objective: entry.objective,
    reward: entry.reward,
    spot: entry.spot || null,
    target: entry.target ? { ...entry.target } : null,
    points: entry.points ? [...entry.points] : null,
    timeLimit: entry.timeLimit || 0,
    targetCarId: entry.targetCarId || null,
    targetCarModel: entry.targetCarModel || null,
    gangCount: entry.gangCount || 0,
    state: entry.state || 'locked',
    // Field runtime, di-reset oleh startMission().
    phase: 'start',
    elapsed: 0,
    timer: 0,
    progress: {},
  };
}

export const missionList = [
  baseMission({
    id: 'm1',
    kind: 'story',
    title: 'Paket Pertama',
    brief:
      'Mira menelepon dari kantor pelabuhan: satu paket kecil harus sampai ' +
      'ke kios Pasar Verda sebelum toko tutup. Anggap saja pemanasan — tapi ' +
      'jangan sampai paketnya rusak di jalan.',
    objective: 'Antar paket ke kios di Pasar Verda.',
    reward: 50,
    spot: 'market',
    target: MISSION_SPOTS.market,
    state: 'active',
  }),
  baseMission({
    id: 'm2',
    kind: 'story',
    title: 'Di Bawah Patroli',
    brief:
      'Ada paket titipan di gudang timur. Polisi pelabuhan sedang rajin ' +
      'merazia malam ini — ambil paketnya tanpa bikin masalah. Kalau ' +
      'bintangmu naik di atas satu, Mira batal bayar.',
    objective: 'Ambil paket di Gudang Timur. Jaga wanted tetap 1 atau kurang.',
    reward: 120,
    spot: 'warehouseEast',
    target: MISSION_SPOTS.warehouseEast,
  }),
  baseMission({
    id: 'm3',
    kind: 'story',
    title: 'Lepas Ekor',
    brief:
      'Sial — patroli mengenalimu. Dua mobil polisi menempel di ekor. Mira ' +
      'bilang: jangan berhenti, jangan panik. Bertahan 60 detik sampai ' +
      'mereka kehilangan jejakmu.',
    objective: 'Lepas dari kejaran polisi selama 60 detik.',
    reward: 200,
    spot: 'pier',
    target: MISSION_SPOTS.pier,
    timeLimit: 60,
  }),
  baseMission({
    id: 'm4',
    kind: 'story',
    title: 'Mobil Target',
    brief:
      'Harbor Kings menyimpan mobil curian di tempat parkir bukit — Falcon GT ' +
      'warna kuning. Curi mobil itu dan bawa ke Bengkel Darto. Jangan sampai ' +
      'mobilnya ringsek di jalan.',
    objective: 'Curi Falcon GT, lalu antar ke Bengkel Darto.',
    reward: 250,
    spot: 'targetCar',
    target: MISSION_SPOTS.targetCar,
    targetCarId: 'target-car',
    targetCarModel: 'Falcon GT',
  }),
  baseMission({
    id: 'm5',
    kind: 'story',
    title: 'Gudang Harbor Kings',
    brief:
      'Ini balasan. Empat anggota Harbor Kings menjaga gudang mereka di ' +
      'timur. Masuk, bereskan mereka, dan ambil kembali paket Mira yang ' +
      'mereka sita.',
    objective: 'Kalahkan 4 anggota Harbor Kings di gudang timur.',
    reward: 400,
    spot: 'warehouseEast',
    target: MISSION_SPOTS.warehouseEast,
    gangCount: 4,
  }),
  baseMission({
    id: 'm6',
    kind: 'story',
    title: 'Finale Pelabuhan',
    brief:
      'Paket terakhir — dokumen pelabuhan yang bisa menjatuhkan Harbor Kings. ' +
      'Seluruh pelabuhan panas, tiga bintang di kepalamu. Bawa paket itu ke ' +
      'dermaga selatan. Di sana kapal Mira menunggu.',
    objective: 'Antar paket terakhir ke Dermaga Selatan selagi wanted 3.',
    reward: 600,
    spot: 'pier',
    target: MISSION_SPOTS.pier,
  }),
  baseMission({
    id: 's1',
    kind: 'side',
    title: 'Taksi Pelabuhan',
    brief:
      'Sambil menunggu kabar Mira, ambil penumpang di depan terminal dan ' +
      'antar mereka ke tiga titik di kota. Argo jalan terus.',
    objective: 'Antar 3 penumpang: Pasar, Kota Tua, lalu Bukit.',
    reward: 90,
    spot: 'harborGate',
    target: MISSION_SPOTS.harborGate,
    points: ['market', 'oldTown', 'hills'],
  }),
  baseMission({
    id: 's2',
    kind: 'side',
    title: 'Paket Kilat',
    brief:
      'Lima paket, satu tenggat: 150 detik. Antar semuanya sebelum waktu ' +
      'habis — kalau telat, Mira yang menanggung malu ke pelanggan.',
    objective: 'Antar 5 paket sebelum waktu habis (150 detik).',
    reward: 150,
    spot: 'downtown',
    target: MISSION_SPOTS.downtown,
    points: ['downtown', 'market', 'oldTown', 'garage', 'pier'],
    timeLimit: 150,
  }),
];

// Salinan segar daftar misi untuk satu permainan baru. main.js WAJIB memakai
// ini (bukan missionList mentah) supaya dua permainan tidak berbagi state.
export function freshMissionList() {
  return JSON.parse(JSON.stringify(missionList));
}

// ---------------------------------------------------------------------------
// Helper internal
// ---------------------------------------------------------------------------

function ensureMissions(state) {
  if (!state.missions) {
    state.missions = { current: 0, list: freshMissionList(), active: null, completed: [] };
  }
  if (!Array.isArray(state.missions.list) || state.missions.list.length === 0) {
    state.missions.list = freshMissionList();
  }
  if (!Array.isArray(state.missions.completed)) state.missions.completed = [];
  // Terapkan progres dari simpanan (save.js B1 hanya menyimpan daftar id
  // selesai + current): tandai misi-misi itu 'done' di daftar baru.
  if (state.missions.completed.length > 0) {
    for (const entry of state.missions.list) {
      if (entry && state.missions.completed.includes(entry.id) && entry.state !== 'done') {
        entry.state = 'done';
        entry.phase = 'done';
      }
    }
  }
  if (typeof state.missions.current !== 'number') state.missions.current = 0;
  if (!state.flags) state.flags = {};
  return state.missions;
}

// Ambil titik bernama: utamakan city.spawns.missionSpots (B1) — dengan
// alias nama lokal -> nama B1 — lalu fallback ke MISSION_SPOTS lokal.
// Mengembalikan salinan {x, y} atau null.
function spotFor(state, city, key) {
  const cityKey = SPOT_ALIASES[key] || key;
  const spotsOf = (c) => (c && c.spawns && c.spawns.missionSpots ? c.spawns.missionSpots : null);
  const fromParam = spotsOf(city);
  const fromState = !fromParam || !fromParam[cityKey] ? spotsOf(state.city) : null;
  const spot =
    (fromParam && fromParam[cityKey]) ||
    (fromState && fromState[cityKey]) ||
    MISSION_SPOTS[key] ||
    null;
  return spot ? { x: spot.x, y: spot.y } : null;
}

function distanceTo(state, target) {
  const p = state.player;
  if (!p || !target) return Infinity;
  const dx = (p.x || 0) - target.x;
  const dy = (p.y || 0) - target.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Jarak (piksel) pemain ke target misi aktif; Infinity bila tidak ada misi.
export function missionDistanceToTarget(state) {
  const missions = state.missions;
  if (!missions || !missions.active || !missions.active.target) return Infinity;
  return distanceTo(state, missions.active.target);
}

function arrived(state, mission) {
  return distanceTo(state, mission.target) <= ARRIVE_RADIUS;
}

// Cari mobil target misi pencurian di state.cars. Cocok lewat id, lalu
// model, lalu penanda isTarget — supaya B2/main bebas memakai salah satunya.
function findTargetCar(state, mission) {
  const cars = Array.isArray(state.cars) ? state.cars : [];
  return (
    cars.find((c) => c && mission.targetCarId && c.id === mission.targetCarId) ||
    cars.find((c) => c && mission.targetCarModel && c.model === mission.targetCarModel) ||
    cars.find((c) => c && c.isTarget === true) ||
    null
  );
}

function targetCarDestroyed(state, mission) {
  const car = findTargetCar(state, mission);
  if (!car) return false; // belum muncul di dunia: belum bisa dibilang hancur
  return car.wrecked === true || (typeof car.health === 'number' && car.health <= 0);
}

// Hitung anggota geng yang sudah kalah di sekitar misi. Dua sumber dihitung
// dan diambil yang terbesar supaya tidak ganda: penghitung flags.gangKills
// (ditambah combat.js) dan pejalan kaki bertanda gang yang sudah tumbang.
function countGangDown(state) {
  let counted = 0;
  if (state.flags && Number.isFinite(state.flags.gangKills)) {
    counted = Math.max(0, Math.floor(state.flags.gangKills));
  }
  const peds = Array.isArray(state.peds) ? state.peds : [];
  let down = 0;
  for (const p of peds) {
    if (p && p.gang === true && (p.dead === true || (typeof p.health === 'number' && p.health <= 0))) {
      down += 1;
    }
  }
  return Math.max(counted, down);
}

// ---------------------------------------------------------------------------
// Penyelesaian / kegagalan
// ---------------------------------------------------------------------------

function completeMission(state, mission, events) {
  mission.state = 'done';
  mission.phase = 'done';
  if (typeof state.money !== 'number') state.money = 0;
  state.money += mission.reward;
  // Catat ke daftar selesai supaya save.js (B1) bisa menyimpan progres.
  const missions = state.missions;
  if (Array.isArray(missions.completed) && !missions.completed.includes(mission.id)) {
    missions.completed.push(mission.id);
  }
  // Bersihkan jadwal retry basi untuk misi ini (mis. pemain me-retry manual
  // sebelum timer retry habis).
  if (state.flags.retryMission === missions.list.indexOf(mission)) {
    state.flags.retryMission = null;
    state.flags.retryIn = 0;
  }
  state.flags.lastMissionEvent = 'complete';
  state.flags.lastMissionId = mission.id;
  state.flags.lastMissionReward = mission.reward;
  // Banner "MISI SELESAI" di HUD tampil selama 4 detik (lihat updateMissions).
  state.flags.missionBannerTimer = 4;
  state.flags.showBrief = false;
  state.flags.briefTimer = 0;
  if (mission.id === 'm4') state.flags.targetCarNeeded = false;
  events.push('mission_complete:' + mission.id);

  missions.active = null;

  if (mission.kind === 'story') {
    // Buka misi cerita berikutnya yang masih terkunci, langsung aktif.
    const nextIndex = missions.list.findIndex(
      (m, idx) => idx > missions.current && m.kind === 'story' && m.state === 'locked',
    );
    if (nextIndex >= 0) {
      startMission(state, nextIndex);
      events.push('mission_start:' + missions.list[nextIndex].id);
    }
  } else if (mission.resumeIndex !== undefined && mission.resumeIndex !== null) {
    // Side job selesai: kembali ke misi cerita yang tadi dijeda.
    const resume = missions.list[mission.resumeIndex];
    if (resume && resume.state === 'active') {
      missions.current = mission.resumeIndex;
      missions.active = resume;
      events.push('mission_resume:' + resume.id);
    }
    mission.resumeIndex = null;
  }
}

function failMission(state, mission, reason, events) {
  mission.state = 'failed';
  mission.phase = 'failed';
  state.flags.lastMissionEvent = 'failed';
  state.flags.lastMissionId = mission.id;
  state.flags.lastMissionFailReason = reason;
  // Banner "MISI GAGAL" di HUD tampil selama 4 detik (lihat updateMissions).
  state.flags.missionBannerTimer = 4;
  state.flags.showBrief = false;
  state.flags.briefTimer = 0;
  if (mission.id === 'm4') state.flags.targetCarNeeded = false;
  events.push('mission_failed:' + mission.id + ':' + reason);

  const missions = state.missions;
  missions.active = null;

  // Misi cerita yang gagal diulang otomatis setelah 6 detik (retry), supaya
  // permainan tidak berhenti tanpa misi aktif. Pengecualian: gagal karena
  // health 0 / busted — layar game over main.js yang mengambil alih, dan
  // updateMissions tidak lagi dipanggil di sana.
  if (
    mission.kind === 'story' &&
    reason !== 'health' &&
    reason !== 'busted' &&
    missions.list.indexOf(mission) >= 0
  ) {
    state.flags.retryMission = missions.list.indexOf(mission);
    state.flags.retryIn = 6;
  }

  if (mission.kind === 'side' && mission.resumeIndex !== undefined && mission.resumeIndex !== null) {
    const resume = missions.list[mission.resumeIndex];
    if (resume && resume.state === 'active') {
      missions.current = mission.resumeIndex;
      missions.active = resume;
      events.push('mission_resume:' + resume.id);
    }
    mission.resumeIndex = null;
  }
}

// ---------------------------------------------------------------------------
// API utama
// ---------------------------------------------------------------------------

// Mulai misi ke-i dari state.missions.list. Mengembalikan true bila misi
// berhasil diaktifkan. Misi cerita yang terkunci hanya bisa dimulai bila
// semua misi cerita sebelumnya sudah 'done'. Side job selalu bisa dimulai.
// Misi 'done' tidak bisa diulang; misi 'failed' bisa dicoba lagi.
// `city` opsional: objek kota B1 (dipakai untuk city.spawns.missionSpots
// dan disimpan ke state.city supaya updateMissions berikutnya memakainya).
export function startMission(state, i, city) {
  const missions = ensureMissions(state);
  if (city) state.city = city;
  const mission = missions.list[i];
  if (!mission) return false;
  if (mission.state === 'done') return false;
  if (mission.state === 'active' && missions.active === mission && mission.elapsed === 0) {
    return true; // sudah aktif dan belum berjalan: tidak perlu reset ulang
  }

  if (mission.kind === 'story' && mission.state === 'locked') {
    for (let k = 0; k < i; k += 1) {
      const prev = missions.list[k];
      if (prev && prev.kind === 'story' && prev.state !== 'done') return false;
    }
  }

  // Side job yang memotong misi cerita aktif: simpan indeksnya untuk resume.
  if (
    mission.kind === 'side' &&
    missions.active &&
    missions.active.kind === 'story' &&
    missions.active.state === 'active'
  ) {
    mission.resumeIndex = missions.current;
  } else {
    mission.resumeIndex = null;
  }

  mission.state = 'active';
  mission.phase = 'start';
  mission.elapsed = 0;
  mission.timer = mission.timeLimit || 0;
  mission.progress = {};
  missions.current = i;
  missions.active = mission;

  // Selesaikan target dari nama spot (utamakan city B1 bila tersedia).
  if (mission.spot) {
    const resolved = spotFor(state, city, mission.spot);
    if (resolved) mission.target = resolved;
  }
  if (mission.points && mission.points.length > 0) {
    mission.progress.index = 0;
    // Side job taksi: target pertama adalah titik penjemputan (spot misi),
    // baru sesudah itu titik-titik antar. Paket kilat: langsung titik pertama.
    if (mission.id === 's1') {
      mission.phase = 'pickup';
    } else {
      const first = spotFor(state, city, mission.points[0]);
      if (first) mission.target = first;
      mission.phase = 'deliver';
    }
  }

  // Efek awal khusus tiap misi.
  if (mission.id === 'm3') {
    state.wanted = 2;
    mission.progress.startWanted = 2;
  }
  if (mission.id === 'm6') {
    state.wanted = 3;
    mission.progress.startWanted = 3;
  }
  if (mission.id === 'm4') {
    state.flags.targetCarNeeded = true;
    const spawn = spotFor(state, city, 'targetCar');
    if (spawn) {
      state.flags.targetCarSpawn = spawn;
      mission.target = { ...spawn };
    }
    mission.phase = 'steal';
  }
  if (mission.id === 'm5') {
    const warehouse = spotFor(state, city, 'warehouseEast');
    state.flags.spawnGang = {
      x: warehouse ? warehouse.x : mission.target.x,
      y: warehouse ? warehouse.y : mission.target.y,
      count: mission.gangCount || 4,
    };
    state.flags.gangKills = 0;
    mission.progress.kills = 0;
    mission.phase = 'fight';
  }

  // Minta main.js menampilkan panel brief misi selama beberapa detik.
  state.flags.showBrief = true;
  state.flags.briefTimer = 6;
  // SENGAJA tidak menyentuh state.flags.lastMissionEvent di sini: bila misi
  // ini di-auto-start oleh completeMission misi sebelumnya, event 'complete'
  // beserta reward-nya harus tetap bisa dibaca HUD / main.js (untuk banner
  // dan jingle) sampai missionBannerTimer-nya habis.
  state.flags.lastMissionId = mission.id;
  return true;
}

// Dipanggil tiap frame oleh main.js. Mengembalikan array event string
// (bisa kosong): 'mission_complete:<id>', 'mission_failed:<id>:<alasan>',
// 'mission_start:<id>', 'mission_resume:<id>', 'target_car_stolen'.
// `city` boleh null/undefined — semua logika memakai state + konstanta lokal.
export function updateMissions(state, dt, city) {
  const events = [];
  if (!state || typeof state !== 'object') return events;
  const missions = ensureMissions(state);
  // Simpan kota B1 di state supaya startMission berikutnya (yang tidak
  // menerima city) tetap bisa memakai city.spawns.missionSpots.
  if (city) state.city = city;
  if (!(dt > 0)) dt = 0;
  // Hitung mundur banner hasil misi ("MISI SELESAI" / "MISI GAGAL" di HUD).
  // Dijalankan sebelum early-return: banner tampil justru saat tidak ada
  // misi aktif (misi baru saja selesai / gagal).
  if (state.flags.missionBannerTimer > 0) {
    state.flags.missionBannerTimer -= dt;
    if (state.flags.missionBannerTimer <= 0) {
      state.flags.lastMissionEvent = 'none';
    }
  }
  const mission = missions.active;
  if (!mission) {
    // Tanpa misi aktif, modul ini menjaga alur cerita tetap berjalan:
    //  1. hitung mundur retry misi cerita yang gagal (lihat failMission);
    //  2. lanjutkan misi yang sedang 'active' tapi belum terpasang
    //     (mis. setelah load save);
    //  3. mulai misi cerita yang ditunjuk state.missions.current;
    //  4. permainan baru: mulai misi cerita pertama.
    // Bila semua misi cerita sudah selesai / gagal tanpa retry, diam.
    if (typeof state.flags.retryMission === 'number' && state.flags.retryIn > 0) {
      state.flags.retryIn -= dt;
      if (state.flags.retryIn <= 0) {
        const retryIndex = state.flags.retryMission;
        state.flags.retryMission = null;
        state.flags.retryIn = 0;
        if (startMission(state, retryIndex)) {
          events.push('mission_retry:' + missions.list[retryIndex].id);
        }
      }
      return events;
    }
    const activeIndex = missions.list.findIndex((m) => m && m.state === 'active');
    if (activeIndex >= 0) {
      startMission(state, activeIndex);
      events.push('mission_resume:' + missions.list[activeIndex].id);
      return events;
    }
    if (
      typeof missions.current === 'number' &&
      missions.list[missions.current] &&
      missions.list[missions.current].kind === 'story' &&
      missions.list[missions.current].state !== 'done'
    ) {
      if (startMission(state, missions.current)) {
        events.push('mission_start:' + missions.list[missions.current].id);
      }
      return events;
    }
    const anyStoryDone = missions.list.some((m) => m && m.kind === 'story' && m.state === 'done');
    const anyStoryFailed = missions.list.some((m) => m && m.kind === 'story' && m.state === 'failed');
    if (!anyStoryDone && !anyStoryFailed) {
      const firstStory = missions.list.findIndex((m) => m && m.kind === 'story');
      if (firstStory >= 0 && startMission(state, firstStory)) {
        events.push('mission_start:' + missions.list[firstStory].id);
      }
    }
    return events;
  }

  // Hitung mundur panel brief misi.
  if (state.flags.briefTimer > 0) {
    state.flags.briefTimer -= dt;
    if (state.flags.briefTimer <= 0) state.flags.showBrief = false;
  }

  mission.elapsed += dt;
  if (mission.timer > 0) mission.timer -= dt;

  // Gagal global: pemain tumbang (WASTED) atau tertangkap (BUSTED) —
  // main.js yang memutuskan tampilan game over; di sini misi ditandai gagal.
  if (typeof state.health === 'number' && state.health <= 0) {
    failMission(state, mission, 'health', events);
    return events;
  }
  if (state.flags && state.flags.busted === true) {
    failMission(state, mission, 'busted', events);
    return events;
  }

  switch (mission.id) {
    case 'm1': {
      if (arrived(state, mission)) completeMission(state, mission, events);
      break;
    }
    case 'm2': {
      if (typeof state.wanted === 'number' && state.wanted > 1) {
        failMission(state, mission, 'wanted', events);
      } else if (arrived(state, mission)) {
        completeMission(state, mission, events);
      }
      break;
    }
    case 'm3': {
      // Lolos lebih cepat bila wanted sudah 0 setelah 15 detik pertama.
      if (typeof state.wanted === 'number' && state.wanted <= 0 && mission.elapsed > 15) {
        completeMission(state, mission, events);
      } else if (mission.timer <= 0) {
        completeMission(state, mission, events);
      }
      break;
    }
    case 'm4': {
      if (targetCarDestroyed(state, mission)) {
        failMission(state, mission, 'car_destroyed', events);
        break;
      }
      const car = findTargetCar(state, mission);
      const inTargetCar =
        !!car && state.player && state.player.onFoot === false && state.player.carId === car.id;
      if (mission.phase === 'steal') {
        if (inTargetCar) {
          mission.phase = 'deliver';
          const garage = spotFor(state, city, 'garage');
          if (garage) mission.target = garage;
          events.push('target_car_stolen');
          state.flags.lastMissionEvent = 'target_car_stolen';
        }
      } else if (inTargetCar && arrived(state, mission)) {
        completeMission(state, mission, events);
      }
      break;
    }
    case 'm5': {
      const kills = countGangDown(state);
      mission.progress.kills = kills;
      if (kills >= (mission.gangCount || 4)) {
        completeMission(state, mission, events);
      }
      break;
    }
    case 'm6': {
      if (arrived(state, mission)) completeMission(state, mission, events);
      break;
    }
    case 's1': {
      if (mission.phase === 'pickup') {
        if (arrived(state, mission)) {
          mission.phase = 'deliver';
          mission.progress.index = 0;
          const next = spotFor(state, city, mission.points[0]);
          if (next) mission.target = next;
          events.push('taxi_pickup');
        }
      } else if (arrived(state, mission)) {
        mission.progress.index += 1;
        if (mission.progress.index >= mission.points.length) {
          completeMission(state, mission, events);
        } else {
          const next = spotFor(state, city, mission.points[mission.progress.index]);
          if (next) mission.target = next;
          events.push('taxi_dropoff:' + mission.progress.index);
        }
      }
      break;
    }
    case 's2': {
      if (arrived(state, mission)) {
        mission.progress.index = (mission.progress.index || 0) + 1;
        if (mission.progress.index >= mission.points.length) {
          completeMission(state, mission, events);
        } else {
          const next = spotFor(state, city, mission.points[mission.progress.index]);
          if (next) mission.target = next;
          events.push('package_delivered:' + mission.progress.index);
        }
      } else if (mission.timer <= 0) {
        failMission(state, mission, 'timeout', events);
      }
      break;
    }
    default: {
      if (arrived(state, mission)) completeMission(state, mission, events);
      break;
    }
  }
  return events;
}
