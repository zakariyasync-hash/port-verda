// hud.js — Port Verda: HUD, layar judul, jeda, game over, dan brief misi.
//
// Semua fungsi menggambar langsung ke canvas 2D dengan bentuk dan teks
// prosedural — tanpa gambar, font, atau aset eksternal. Setiap fungsi
// defensif: field state yang belum ada diganti nilai aman, supaya layar
// tidak pernah crash karena satu modul lain belum siap.
//
// Jam di HUD: state.time dihitung sebagai detik sejak permainan dimulai,
// jam dunia dimulai pukul 08:00 (lihat formatClock).
// Jarak misi ditampilkan dalam meter: 10 piksel dunia = 1 meter.
// Kecepatan mobil: player.speed (piksel/detik) x 0.25 = km/jam (perkiraan).

// ---------------------------------------------------------------------------
// Helper gambar
// ---------------------------------------------------------------------------

// Kedip berbasis jam dinding (bukan state.time) supaya tetap berkedip di
// layar judul / game over, saat jam permainan belum berjalan / sudah berhenti.
function blinkOn() {
  return Math.abs(Math.sin(Date.now() / 450)) > 0.25;
}

function canvasSize(ctx) {
  const c = ctx && ctx.canvas ? ctx.canvas : null;
  return { w: (c && c.width) || 1280, h: (c && c.height) || 720 };
}

function panel(ctx, x, y, w, h, fill, border) {
  ctx.save();
  ctx.fillStyle = fill || 'rgba(8, 12, 18, 0.72)';
  ctx.strokeStyle = border || 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function text(ctx, str, x, y, font, color, align) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color || '#ffffff';
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(str), x, y);
  ctx.restore();
}

function wrapText(ctx, str, maxWidth) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function formatClock(timeSeconds) {
  const base = 8 * 3600; // dunia mulai pukul 08:00
  const total = base + Math.max(0, Math.floor(timeSeconds || 0));
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

export function formatMoney(amount) {
  const n = Math.round(amount || 0);
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + '$' + digits;
}

export function formatDistance(px) {
  if (!Number.isFinite(px)) return '—';
  const meters = Math.max(0, Math.round(px / 10));
  if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
  return meters + ' m';
}

function drawStar(ctx, cx, cy, r, filled) {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = filled ? '#ffd23e' : 'rgba(255, 255, 255, 0.18)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawBar(ctx, x, y, w, h, ratio, fillColor) {
  const r = Math.max(0, Math.min(1, ratio));
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fillColor;
  ctx.fillRect(x + 1, y + 1, Math.max(0, (w - 2) * r), h - 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

function healthColor(health) {
  if (health >= 60) return '#3ddc5f';
  if (health >= 30) return '#ffb02e';
  return '#ff3b30';
}

// ---------------------------------------------------------------------------
// HUD utama (selama bermain)
// ---------------------------------------------------------------------------

export function drawHUD(ctx, state) {
  if (!ctx || !state) return;
  const { w, h } = canvasSize(ctx);
  const player = state.player || {};
  const health = typeof state.health === 'number' ? state.health : 100;
  const money = typeof state.money === 'number' ? state.money : 0;
  const wanted = typeof state.wanted === 'number' ? state.wanted : 0;
  const missions = state.missions || {};
  const active = missions.active || null;

  // Peringatan nyawa kritis: bingkai merah berdenyut di tepi layar.
  if (health > 0 && health < 30) {
    const pulse = 0.10 + 0.08 * Math.abs(Math.sin((state.time || 0) * 4));
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 45, 30, ' + pulse.toFixed(3) + ')';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.restore();
  }

  // --- Kiri atas: nyawa, uang, senjata ---
  panel(ctx, 12, 12, 232, 76, 'rgba(8, 12, 18, 0.72)');
  text(ctx, 'NYAWA', 22, 28, 'bold 11px system-ui, sans-serif', '#9fb4c8');
  drawBar(ctx, 78, 20, 150, 14, health / 100, healthColor(health));
  text(ctx, String(Math.max(0, Math.ceil(health))), 234, 28, 'bold 12px system-ui, sans-serif', '#ffffff', 'right');
  text(ctx, formatMoney(money), 22, 54, 'bold 20px system-ui, sans-serif', '#7dff8a');
  const weaponLabel =
    !player.weapon || player.weapon === 'fists'
      ? 'TANGAN KOSONG'
      : String(player.weapon).toUpperCase() + '  •  ' + (player.ammo || 0) + ' peluru';
  text(ctx, weaponLabel, 22, 76, '11px system-ui, sans-serif', '#cfd8e3');

  // --- Kanan atas, DI BAWAH minimap: bintang wanted + jam ---
  // Minimap render.js menempati kanan-atas (y 9..161, lebar 190+margin),
  // jadi blok ini digeser ke y=168 supaya tidak menutup peta.
  // Panelnya harus memuat bintang + "WANTED n/5" + jam + "PORT VERDA":
  // tingginya 116 px supaya jam tidak jatuh di luar panel.
  panel(ctx, w - 212, 168, 200, 116, 'rgba(8, 12, 18, 0.72)');
  for (let i = 0; i < 5; i += 1) {
    drawStar(ctx, w - 188 + i * 30, 190, 11, i < wanted);
  }
  text(ctx, 'WANTED  ' + wanted + '/5', w - 22, 214, 'bold 11px system-ui, sans-serif', '#ffd23e', 'right');
  text(ctx, formatClock(state.time), w - 22, 248, 'bold 22px system-ui, sans-serif', '#ffffff', 'right');
  text(ctx, 'PORT VERDA', w - 22, 268, '11px system-ui, sans-serif', '#9fb4c8', 'right');

  // --- Tracker misi (kiri, di bawah panel nyawa) ---
  if (active) {
    const dist = missionDistancePx(state, active);
    const title = active.title || 'Misi';
    const objective = active.objective || '';
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    const objLines = wrapText(ctx, objective, 216);
    const boxH = 62 + objLines.length * 16;
    panel(ctx, 12, 100, 244, boxH, 'rgba(8, 12, 18, 0.72)', 'rgba(255, 210, 62, 0.45)');
    text(ctx, 'MISI: ' + title.toUpperCase(), 22, 120, 'bold 13px system-ui, sans-serif', '#ffd23e');
    objLines.forEach((line, idx) => {
      text(ctx, line, 22, 142 + idx * 16, '12px system-ui, sans-serif', '#e8eef4');
    });
    text(ctx, 'Jarak: ' + formatDistance(dist), 22, 122 + objLines.length * 16 + 22, 'bold 12px system-ui, sans-serif', '#7dff8a');
    ctx.restore();
  }

  // --- Kecepatan (kanan bawah, hanya saat mengemudi) ---
  if (player.onFoot === false) {
    const kmh = Math.max(0, Math.round(Math.abs(player.speed || 0) * 0.25));
    panel(ctx, w - 132, h - 64, 120, 52, 'rgba(8, 12, 18, 0.72)');
    text(ctx, String(kmh), w - 72, h - 46, 'bold 26px system-ui, sans-serif', '#ffffff', 'center');
    text(ctx, 'km/jam', w - 72, h - 24, '11px system-ui, sans-serif', '#9fb4c8', 'center');
  }

  // --- Hint kontrol (kiri bawah, kecil) ---
  text(ctx, 'WASD gerak  •  E mobil  •  F pukul  •  Klik tembak  •  P jeda  •  M suara', 14, h - 14, '11px system-ui, sans-serif', 'rgba(255, 255, 255, 0.55)');

  // --- Pesan misi terakhir (tengah atas, 4 detik setelah misi berakhir) ---
  // Timer-nya dihitung mundur oleh updateMissions (missions.js); HUD hanya
  // membaca supaya banner tidak menempel selamanya di layar.
  const flags = state.flags || {};
  if (flags.missionBannerTimer > 0 && flags.lastMissionEvent === 'complete' && flags.lastMissionReward) {
    text(ctx, 'MISI SELESAI  •  +' + formatMoney(flags.lastMissionReward), w / 2, 30, 'bold 18px system-ui, sans-serif', '#7dff8a', 'center');
  } else if (flags.missionBannerTimer > 0 && flags.lastMissionEvent === 'failed') {
    text(ctx, 'MISI GAGAL', w / 2, 30, 'bold 18px system-ui, sans-serif', '#ff6b5e', 'center');
  }
}

function missionDistancePx(state, active) {
  const p = state.player || {};
  const t = active.target || {};
  if (typeof p.x !== 'number' || typeof t.x !== 'number') return Infinity;
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Layar judul
// ---------------------------------------------------------------------------

export function drawTitle(ctx, state) {
  if (!ctx) return;
  const { w, h } = canvasSize(ctx);
  const flags = (state && state.flags) || {};
  const hasSave = flags.hasSave === true;

  // main.js menggambar dunia kota DULU lalu layar ini, jadi latar dibuat
  // tembus pandang (veil gelap + siluet kota samar) supaya kotanya tetap
  // terlihat di belakang judul. Di canvas kosong pun tetap terbaca.
  ctx.save();
  ctx.fillStyle = 'rgba(10, 16, 28, 0.62)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(242, 163, 94, 0.85)';
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.30, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(16, 26, 46, 0.85)';
  const skyline = [0.10, 0.16, 0.12, 0.22, 0.14, 0.20, 0.11, 0.18, 0.13, 0.24, 0.12, 0.17];
  let sx = 0;
  const baseY = h * 0.86;
  skyline.forEach((frac) => {
    const bw = w / skyline.length;
    ctx.fillRect(sx, baseY - h * frac, bw - 4, h * frac + h * 0.14);
    sx += bw;
  });
  ctx.fillStyle = 'rgba(10, 18, 32, 0.9)';
  ctx.fillRect(0, baseY, w, h - baseY);
  ctx.restore();

  // Judul.
  text(ctx, 'PORT VERDA', w / 2, h * 0.30, 'bold 72px system-ui, sans-serif', '#ffd23e', 'center');
  text(ctx, 'Kota pelabuhan. Satu kurir. Enam misi.', w / 2, h * 0.30 + 52, '20px system-ui, sans-serif', '#e8eef4', 'center');
  text(ctx, 'Raka  •  Mira  •  Harbor Kings', w / 2, h * 0.30 + 82, '14px system-ui, sans-serif', '#9fb4c8', 'center');

  // Daftar kontrol.
  const controls = [
    'WASD / Panah — jalan & mengemudi',
    'E — masuk / keluar mobil',
    'F — pukul      •      Klik mouse — tembak',
    'Shift — rem tangan      •      P — jeda      •      M — suara',
  ];
  panel(ctx, w / 2 - 260, h * 0.52, 520, 30 + controls.length * 26, 'rgba(8, 12, 18, 0.66)');
  controls.forEach((line, idx) => {
    text(ctx, line, w / 2, h * 0.52 + 26 + idx * 26, '15px system-ui, sans-serif', '#dbe4ee', 'center');
  });

  // Aksi mulai.
  if (blinkOn()) {
    text(ctx, 'TEKAN ENTER UNTUK MULAI', w / 2, h * 0.80, 'bold 24px system-ui, sans-serif', '#ffffff', 'center');
  }
  if (hasSave) {
    text(ctx, 'atau tekan L untuk lanjutkan simpanan terakhir', w / 2, h * 0.80 + 34, '15px system-ui, sans-serif', '#7dff8a', 'center');
  }
  text(ctx, 'Game orisinal — semua nama, karakter, dan kota di sini fiktif.', w / 2, h - 24, '12px system-ui, sans-serif', 'rgba(255, 255, 255, 0.5)', 'center');
}

// ---------------------------------------------------------------------------
// Jeda
// ---------------------------------------------------------------------------

export function drawPause(ctx, state) {
  if (!ctx) return;
  const { w, h } = canvasSize(ctx);
  ctx.save();
  ctx.fillStyle = 'rgba(4, 8, 14, 0.62)';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  panel(ctx, w / 2 - 220, h / 2 - 90, 440, 180, 'rgba(8, 12, 18, 0.88)');
  text(ctx, 'JEDA', w / 2, h / 2 - 48, 'bold 44px system-ui, sans-serif', '#ffffff', 'center');
  text(ctx, 'P — lanjut bermain', w / 2, h / 2 + 6, '16px system-ui, sans-serif', '#dbe4ee', 'center');
  text(ctx, 'M — suara hidup / mati', w / 2, h / 2 + 32, '16px system-ui, sans-serif', '#dbe4ee', 'center');
  text(ctx, 'R — mulai dari awal', w / 2, h / 2 + 58, '16px system-ui, sans-serif', '#dbe4ee', 'center');
  if (state) {
    text(ctx, 'Uang: ' + formatMoney(state.money) + '   •   ' + formatClock(state.time), w / 2, h / 2 + 84, '13px system-ui, sans-serif', '#9fb4c8', 'center');
  }
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------

// `screen` opsional ('busted' | 'wasted') — dipakai main.js yang
// memanggil drawGameOver(ctx, state, screen). Bila tidak diberikan,
// keputusan diambil dari state.flags.busted.
export function drawGameOver(ctx, state, screen) {
  if (!ctx) return;
  const { w, h } = canvasSize(ctx);
  const flags = (state && state.flags) || {};
  const busted = screen === 'busted' || (screen !== 'wasted' && flags.busted === true);
  const word = busted ? 'BUSTED' : 'WASTED';
  const color = busted ? '#4db2ff' : '#ff3b30';
  const sub = busted
    ? 'Polisi pelabuhan menangkapmu. Raka masuk sel tahanan.'
    : 'Raka tumbang di jalanan Port Verda.';
  ctx.save();
  ctx.fillStyle = 'rgba(10, 4, 6, 0.72)';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  text(ctx, word, w / 2, h * 0.42, 'bold 84px system-ui, sans-serif', color, 'center');
  text(ctx, sub, w / 2, h * 0.42 + 62, '18px system-ui, sans-serif', '#e8eef4', 'center');
  if (state) {
    text(
      ctx,
      'Uang: ' + formatMoney(state.money) + '   •   Misi selesai: ' + countDoneMissions(state),
      w / 2,
      h * 0.42 + 96,
      '15px system-ui, sans-serif',
      '#9fb4c8',
      'center',
    );
  }
  if (blinkOn()) {
    text(ctx, 'TEKAN R UNTUK MULAI LAGI', w / 2, h * 0.42 + 150, 'bold 22px system-ui, sans-serif', '#ffffff', 'center');
  }
}

function countDoneMissions(state) {
  const list = (state.missions && state.missions.list) || [];
  return list.filter((m) => m && m.state === 'done').length;
}

// ---------------------------------------------------------------------------
// Brief misi (panel tengah, tampil saat misi baru dimulai)
// ---------------------------------------------------------------------------

export function drawMissionBrief(ctx, state) {
  if (!ctx || !state) return;
  const missions = state.missions || {};
  const active = missions.active;
  if (!active) return;
  const { w, h } = canvasSize(ctx);
  ctx.save();
  ctx.font = '15px system-ui, sans-serif';
  const briefLines = wrapText(ctx, active.brief || '', 460);
  const boxH = 132 + briefLines.length * 20;
  const boxY = h / 2 - boxH / 2;
  ctx.fillStyle = 'rgba(4, 8, 14, 0.55)';
  ctx.fillRect(0, 0, w, h);
  panel(ctx, w / 2 - 260, boxY, 520, boxH, 'rgba(8, 12, 18, 0.92)', 'rgba(255, 210, 62, 0.55)');
  text(ctx, 'MISI BARU', w / 2, boxY + 26, 'bold 13px system-ui, sans-serif', '#ffd23e', 'center');
  text(ctx, active.title || 'Misi', w / 2, boxY + 56, 'bold 28px system-ui, sans-serif', '#ffffff', 'center');
  briefLines.forEach((line, idx) => {
    text(ctx, line, w / 2, boxY + 88 + idx * 20, '15px system-ui, sans-serif', '#dbe4ee', 'center');
  });
  text(ctx, 'Tujuan: ' + (active.objective || ''), w / 2, boxY + 92 + briefLines.length * 20, 'bold 14px system-ui, sans-serif', '#7dff8a', 'center');
  text(ctx, 'Hadiah: ' + formatMoney(active.reward), w / 2, boxY + 116 + briefLines.length * 20, 'bold 15px system-ui, sans-serif', '#ffd23e', 'center');
  ctx.restore();
}
