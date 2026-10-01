export interface MotionState { position: number; velocity: number }
export interface MotionSample { position: number; at: number }
export interface MotionClock {
  now: () => number;
  request: (callback: FrameRequestCallback) => number;
  cancel: (frame: number) => void;
  reduced: () => boolean;
}

/** Critically damped, evaluated analytically so a slow frame cannot destabilize it. */
export function stepSpring(state: MotionState, target: number, seconds: number, response = .3): MotionState {
  const frequency = 2 * Math.PI / response;
  const displacement = state.position - target;
  const combined = state.velocity + frequency * displacement;
  const decay = Math.exp(-frequency * Math.max(0, seconds));
  return {
    position: target + (displacement + combined * Math.max(0, seconds)) * decay,
    velocity: (state.velocity - frequency * combined * Math.max(0, seconds)) * decay,
  };
}

/** Use the last movement, including a pause before release, rather than the whole drag. */
export function recentVelocity(samples: readonly MotionSample[], now: number, windowMs = 100): number {
  const last = samples.at(-1);
  if (!last || now - last.at >= windowMs) return 0;
  const first = samples.find(sample => sample.at >= now - windowMs && sample.at < last.at);
  if (!first) return 0;
  return (last.position - first.position) / (last.at - first.at) * 1000 * Math.max(0, 1 - (now - last.at) / windowMs);
}

/** Exponential scroll projection, with velocity in px/s. */
export function projectMomentum(velocity: number, deceleration = .998): number {
  return velocity / 1000 * deceleration / (1 - deceleration);
}

export const clampDrawer = (position: number, width: number) => Math.max(-width, Math.min(0, position));
export const projectedDrawerOpen = (position: number, velocity: number, width: number) =>
  width > 0 && clampDrawer(position + projectMomentum(velocity), width) > -width / 2;

export function drawerIntent(dx: number, dy: number, position: number, width: number): 'pending' | 'horizontal' | 'vertical' | 'outward' {
  if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return 'vertical';
  if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return 'pending';
  if ((position <= -width && dx < 0) || (position >= 0 && dx > 0)) return 'outward';
  return 'horizontal';
}

/** One presented value. Retargeting carries velocity; stopping leaves the visible value intact. */
export function createSpringMotion(initial: number, write: (position: number) => void, rest: () => void = () => {}, clock: MotionClock = {
  now: () => performance.now(), request: callback => requestAnimationFrame(callback),
  cancel: frame => cancelAnimationFrame(frame), reduced: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
}, response = .3) {
  let state: MotionState = { position: initial, velocity: 0 };
  let target = initial;
  let frame: number | null = null;
  let previous = 0;
  const stop = () => { if (frame !== null) clock.cancel(frame); frame = null; return { ...state }; };
  const finish = () => { stop(); state = { position: target, velocity: 0 }; write(target); rest(); };
  const tick: FrameRequestCallback = at => {
    frame = null;
    if (clock.reduced()) { finish(); return; }
    state = stepSpring(state, target, (at - previous) / 1000, response);
    previous = at;
    write(state.position);
    if (Math.abs(state.position - target) < .2 && Math.abs(state.velocity) < 3) finish();
    else frame = clock.request(tick);
  };
  return {
    get state() { return { ...state }; },
    get running() { return frame !== null; },
    stop,
    set(position: number, velocity = 0) { stop(); state = { position, velocity }; write(position); },
    to(next: number, velocity?: number) {
      if (next === target && frame !== null && velocity === undefined) return;
      stop(); target = next;
      if (velocity !== undefined) state.velocity = velocity;
      if (clock.reduced() || (Math.abs(state.position - target) < .2 && Math.abs(state.velocity) < 3)) { finish(); return; }
      previous = clock.now(); frame = clock.request(tick);
    },
    finish,
  };
}
