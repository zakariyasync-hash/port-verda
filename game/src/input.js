// input.js — Port Verda keyboard + mouse input (Builder B3).
//
// Written from scratch in this session. Vanilla DOM events only, no library.
// Two APIs, one listener set:
//   * New API: the shared `Input` object + attachInput(canvas, state).
//     main.js (B1) calls attachInput once; the game loop reads Input.keys,
//     Input.direction(), Input.mouse, and the edge helper keyPressed(code).
//   * Legacy API: createInput(target) / ACTION_CONFIRM / ACTION_PAUSE, kept so
//     the starter main.js keeps working until B1 rewrites it. Both APIs share
//     the same underlying listeners (attachInput installs them once).
//
// Controls (see task contract): WASD/arrows move, E enter/exit car, F punch,
// click shoot, Shift boost/brake, P pause, M mute, Enter confirm.
// Arrow keys and Space never scroll the page.

export const ACTION_CONFIRM = 1;
export const ACTION_PAUSE = 2;

const LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);
const UP_KEYS = new Set(['ArrowUp', 'KeyW']);
const DOWN_KEYS = new Set(['ArrowDown', 'KeyS']);
const CONFIRM_KEYS = new Set(['Space', 'Enter']);
const PAUSE_KEYS = new Set(['KeyP', 'Escape']);
const MUTE_KEYS = new Set(['KeyM']);
const INTERACT_KEYS = new Set(['KeyE']);
const PUNCH_KEYS = new Set(['KeyF']);
const BOOST_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
// Keys whose browser default (scroll / button activation) must be suppressed.
const PREVENT_DEFAULT = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space',
]);

/**
 * Shared input state. `keys` holds currently-down KeyboardEvent.code values.
 * `pressed` holds codes pressed since the last endFrame() — edge detection.
 * `mouse` is in canvas CSS pixels; world conversion happens in main/render
 * via the camera (see mouseWorld below). `actions` is the legacy bitfield.
 */
export const Input = {
  keys: new Set(),
  pressed: new Set(),
  mouse: { x: 0, y: 0, down: false, clicked: false },
  actions: 0,
  attached: false,

  isDown(code) {
    return this.keys.has(code);
  },
  /** True only on the frame the key went down (cleared by endFrame). */
  keyPressed(code) {
    return this.pressed.has(code);
  },
  /** -1/0/1 horizontal steering from A/D or arrows. */
  directionX() {
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    return (right ? 1 : 0) - (left ? 1 : 0);
  },
  /** -1/0/1 vertical steering from W/S or arrows (up = -1). */
  directionY() {
    const up = this.keys.has('ArrowUp') || this.keys.has('KeyW');
    const down = this.keys.has('ArrowDown') || this.keys.has('KeyS');
    return (down ? 1 : 0) - (up ? 1 : 0);
  },
  /** {x, y} steering vector, each component -1/0/1. */
  direction() {
    return { x: this.directionX(), y: this.directionY() };
  },
  /** Legacy one-shot flags since the last takeActions(). */
  takeActions() {
    const taken = this.actions;
    this.actions = 0;
    return taken;
  },
  /** Call once per frame after the game has consumed edge presses. */
  endFrame() {
    this.pressed.clear();
    this.mouse.clicked = false;
  },
  /** Convert the mouse position to world coordinates via the camera.
   *  B1's convention (render.js drawWorld): state.camera is the viewport's
   *  top-left corner in world px, and the canvas is drawn 1:1 in canvas px,
   *  so world = camera + mouse (mouse is in canvas CSS px; the game canvas
   *  is sized to its display box). With state.cameraCentered set, the camera
   *  is instead the viewport centre in a 1280x720 logical field. */
  mouseWorld(state) {
    const cam = (state && state.camera) || { x: 0, y: 0 };
    const pl = (state && state.player) || { x: 0, y: 0 };
    if (state && state.cameraCentered) {
      const cx = cam.x ?? pl.x ?? 0;
      const cy = cam.y ?? pl.y ?? 0;
      return { x: cx + (this.mouse.x - 640), y: cy + (this.mouse.y - 360) };
    }
    return { x: (cam.x ?? 0) + this.mouse.x, y: (cam.y ?? 0) + this.mouse.y };
  },
};

/** Standalone edge helper (same set Input.keyPressed reads). */
export function keyPressed(code) {
  return Input.keyPressed(code);
}

function onKeyDown(event) {
  if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
  if (event.repeat) return;
  Input.keys.add(event.code);
  Input.pressed.add(event.code);
  if (CONFIRM_KEYS.has(event.code)) Input.actions |= ACTION_CONFIRM;
  if (PAUSE_KEYS.has(event.code)) Input.actions |= ACTION_PAUSE;
}

function onKeyUp(event) {
  Input.keys.delete(event.code);
}

function onBlur() {
  // A key released while the tab is hidden never sends keyup: let go of all.
  Input.keys.clear();
  Input.mouse.down = false;
}

function canvasPos(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Install listeners once and wire the shared Input into `state.input`.
 * Safe to call twice (second call is a no-op). Returns Input.
 * `canvas` may be null in headless tests — keyboard still attaches to window.
 */
export function attachInput(canvas, state) {
  if (Input.attached) {
    if (state) state.input = Input;
    return Input;
  }
  Input.attached = true;
  const targetWindow = typeof window !== 'undefined' ? window : null;
  if (targetWindow) {
    targetWindow.addEventListener('keydown', onKeyDown);
    targetWindow.addEventListener('keyup', onKeyUp);
    targetWindow.addEventListener('blur', onBlur);
  }
  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('pointermove', (event) => {
      const p = canvasPos(canvas, event);
      Input.mouse.x = p.x;
      Input.mouse.y = p.y;
    });
    canvas.addEventListener('pointerdown', (event) => {
      const p = canvasPos(canvas, event);
      Input.mouse.x = p.x;
      Input.mouse.y = p.y;
      Input.mouse.down = true;
      Input.mouse.clicked = true;
      Input.actions |= ACTION_CONFIRM;
    });
    canvas.addEventListener('pointerup', () => {
      Input.mouse.down = false;
    });
    canvas.addEventListener('pointerleave', () => {
      Input.mouse.down = false;
    });
    // Don't let the browser steal right-click / long-press gestures.
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }
  if (state) state.input = Input;
  return Input;
}

/** Legacy starter API: same listeners, paddle-style interface. */
export function createInput(target) {
  attachInput(target, null);
  return {
    direction() {
      return Input.directionX();
    },
    takeActions() {
      return Input.takeActions();
    },
  };
}

export { LEFT_KEYS, RIGHT_KEYS, UP_KEYS, DOWN_KEYS, CONFIRM_KEYS, PAUSE_KEYS, MUTE_KEYS, INTERACT_KEYS, PUNCH_KEYS, BOOST_KEYS };
