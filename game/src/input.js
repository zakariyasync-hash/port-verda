// input.js — Port Verda: keyboard + mouse untuk canvas game.
//
// createInput() mengembalikan satu objek input yang dipakai main.js:
//   input.keys    Set berisi e.code tombol yang sedang ditekan
//   input.mouse   { x, y, clicked, down, button, worldX, worldY } posisi mouse
//   input.attach(canvas)   pasang semua listener
//   input.detach()         lepas semua listener
//   input.isDown(code)     true bila tombol sedang ditekan
//   input.pressed(code)    true bila tombol baru ditekan sejak frame lalu
//   input.consumeClick()   true sekali bila mouse baru diklik
//   input.endFrame()       dibersihkan main.js di akhir tiap frame
//   input.updateWorldCoords(camera)  isi worldX/worldY dari kamera main.js
//
// Koordinat dunia mouse (worldX/worldY) sengaja TIDAK dihitung otomatis
// di mousedown: kamera dimiliki main.js. main.js memanggil
// updateWorldCoords(camera) tiap frame (atau mengisi field-nya langsung).
// Kamera di Port Verda adalah TITIK PUSAT pandangan (lihat render.js B1:
// vx = cam.x - vw/2), jadi rumusnya memakai setengah lebar/tinggi canvas.
// Bila input belum di-attach ke canvas, fallback ke asumsi kamera sebagai
// sudut kiri-atas supaya hasilnya tetap terdefinisi.
// Mouse.clicked tetap true sampai main.js mengambilnya via consumeClick(),
// supaya satu klik tidak hilang di antara dua frame.

const PREVENT_DEFAULT_CODES = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

export function createInput() {
  const keys = new Set();
  const justPressed = new Set();
  // down: true selama tombol mouse (kiri) ditahan — untuk tembak-tahan.
  // button: tombol mouse terakhir yang ditekan (0 kiri, 1 tengah, 2 kanan).
  const mouse = { x: 0, y: 0, clicked: false, down: false, button: 0, worldX: 0, worldY: 0 };
  let canvas = null;
  let attached = false;

  function canvasPos(event) {
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function onKeyDown(event) {
    if (PREVENT_DEFAULT_CODES.has(event.code)) {
      event.preventDefault();
    }
    // Abaikan pengulangan otomatis saat tombol ditahan (key repeat).
    if (!event.repeat && !keys.has(event.code)) {
      justPressed.add(event.code);
    }
    keys.add(event.code);
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function onBlur() {
    // Jangan sampai tombol "nyangkut" bila jendela kehilangan fokus.
    keys.clear();
    justPressed.clear();
  }

  function onMouseMove(event) {
    const pos = canvasPos(event);
    mouse.x = pos.x;
    mouse.y = pos.y;
  }

  function onMouseDown(event) {
    const pos = canvasPos(event);
    mouse.x = pos.x;
    mouse.y = pos.y;
    mouse.clicked = true;
    mouse.down = true;
    mouse.button = event.button || 0;
    // worldX/worldY diisi main.js lewat updateWorldCoords(camera).
    if (event.button === 0 && event.preventDefault) {
      event.preventDefault();
    }
  }

  function onMouseUp(event) {
    const pos = canvasPos(event);
    mouse.x = pos.x;
    mouse.y = pos.y;
    mouse.down = false;
  }

  function onContextMenu(event) {
    // Klik kanan tidak membuka menu browser di atas canvas game.
    event.preventDefault();
  }

  function attach(targetCanvas) {
    if (attached) detach();
    canvas = targetCanvas || null;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    }
    if (canvas) {
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('contextmenu', onContextMenu);
    }
    attached = true;
    return input;
  }

  function detach() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
    if (canvas) {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
    }
    canvas = null;
    attached = false;
    keys.clear();
    justPressed.clear();
    mouse.clicked = false;
    mouse.down = false;
  }

  function isDown(code) {
    return keys.has(code);
  }

  function pressed(code) {
    return justPressed.has(code);
  }

  function consumeClick() {
    const wasClicked = mouse.clicked;
    mouse.clicked = false;
    return wasClicked;
  }

  // Dipanggil main.js sekali di akhir tiap frame, setelah semua sistem
  // sempat membaca pressed(). Tanpa ini, pressed() akan tetap true.
  function endFrame() {
    justPressed.clear();
  }

  // Isi worldX/worldY dari posisi mouse + kamera. Kamera berbentuk
  // { x, y } TITIK PUSAT pandangan dunia (kontrak main.js/render.js B1).
  // Boleh dipanggil tiap frame; tanpa canvas terpasang, kamera dianggap
  // sudut kiri-atas (fallback lama).
  function updateWorldCoords(camera) {
    const cx = camera && typeof camera.x === 'number' ? camera.x : 0;
    const cy = camera && typeof camera.y === 'number' ? camera.y : 0;
    if (canvas) {
      const vw = canvas.clientWidth || canvas.width || 0;
      const vh = canvas.clientHeight || canvas.height || 0;
      mouse.worldX = cx + (mouse.x - vw / 2);
      mouse.worldY = cy + (mouse.y - vh / 2);
    } else {
      mouse.worldX = mouse.x + cx;
      mouse.worldY = mouse.y + cy;
    }
  }

  const input = {
    keys,
    mouse,
    attach,
    detach,
    isDown,
    pressed,
    consumeClick,
    endFrame,
    updateWorldCoords,
  };
  return input;
}
