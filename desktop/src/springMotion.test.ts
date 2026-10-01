import { describe, expect, it } from 'vitest';
import { createSpringMotion, drawerIntent, projectedDrawerOpen, projectMomentum, recentVelocity, stepSpring, type MotionClock } from './springMotion';

function fixture(initial = -320) {
  let now = 0, sequence = 0, reduced = false;
  const frames = new Map<number, FrameRequestCallback>();
  const positions: number[] = [];
  let rests = 0;
  const clock: MotionClock = {
    now: () => now, request: callback => { frames.set(++sequence, callback); return sequence; },
    cancel: frame => { frames.delete(frame); }, reduced: () => reduced,
  };
  const motion = createSpringMotion(initial, value => positions.push(value), () => rests++, clock);
  return { motion, frames, positions, get rests() { return rests; },
    reduce() { reduced = true; },
    advance(ms: number) { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); },
  };
}

describe('drawer intent and momentum', () => {
  it('keeps vertical scroll and uncertain motion out of the horizontal recognizer', () => {
    expect(drawerIntent(5, 7, -320, 320)).toBe('pending');
    expect(drawerIntent(20, 60, -320, 320)).toBe('vertical');
    expect(drawerIntent(25, 24, -320, 320)).toBe('pending');
    expect(drawerIntent(30, 3, -320, 320)).toBe('horizontal');
  });
  it('allows reversing an interrupted drawer in either direction, while respecting its boundaries', () => {
    expect(drawerIntent(-30, 0, -320, 320)).toBe('outward');
    expect(drawerIntent(30, 0, 0, 320)).toBe('outward');
    expect(drawerIntent(-30, 0, -140, 320)).toBe('horizontal');
    expect(drawerIntent(30, 0, -140, 320)).toBe('horizontal');
  });
  it('uses recent reversal instead of the average velocity since touch-down', () => {
    const samples = [{ position: 0, at: 0 }, { position: 300, at: 600 }, { position: 240, at: 680 }];
    expect(recentVelocity(samples, 680)).toBe(-750);
    expect(projectedDrawerOpen(-80, recentVelocity(samples, 680), 320)).toBe(false);
  });
  it('lets a stationary release settle by position rather than an old flick', () => {
    expect(recentVelocity([{ position: 0, at: 0 }, { position: 100, at: 20 }], 150)).toBe(0);
    expect(projectedDrawerOpen(-200, 0, 320)).toBe(false);
    expect(projectedDrawerOpen(-120, 0, 320)).toBe(true);
  });
  it('projects signed momentum and commits a short intentional flick', () => {
    expect(projectMomentum(1000)).toBeCloseTo(499);
    expect(projectMomentum(-1000)).toBeCloseTo(-499);
    expect(projectedDrawerOpen(-290, 600, 320)).toBe(true);
    expect(projectedDrawerOpen(-30, -600, 320)).toBe(false);
  });
});

describe('interruptible presented motion', () => {
  it('remains stable at slow frame rates and settles without gratuitous bounce', () => {
    const frame = stepSpring({ position: -320, velocity: 0 }, 0, .25);
    expect(frame.position).toBeGreaterThan(-320); expect(frame.position).toBeLessThan(0);
    const settled = stepSpring(frame, 0, 2);
    expect(settled.position).toBeCloseTo(0); expect(settled.velocity).toBeCloseTo(0);
  });
  it('can be grabbed without changing the displayed position, then follows the new finger offset', () => {
    const f = fixture(); f.motion.to(0); f.advance(80);
    const presented = f.positions.at(-1)!;
    const grabbed = f.motion.stop();
    expect(grabbed.position).toBe(presented); expect(f.frames.size).toBe(0);
    f.motion.set(grabbed.position - 12);
    expect(f.positions.at(-1)).toBe(presented - 12);
  });
  it('retargets from the current value and velocity instead of jumping to the previous destination', () => {
    const f = fixture(); f.motion.to(0); f.advance(80);
    const before = f.motion.state;
    f.motion.to(-320);
    expect(f.motion.state).toEqual(before);
    f.advance(16);
    expect(Math.abs(f.motion.state.position - before.position)).toBeLessThan(50);
    for (let i = 0; i < 50; i++) f.advance(16);
    expect(f.motion.state.position).toBe(-320); expect(f.frames.size).toBe(0);
  });
  it('hands the release velocity to the settling motion', () => {
    const f = fixture(-140); f.motion.to(0, 600);
    expect(f.motion.state.velocity).toBe(600);
    f.advance(16); expect(f.motion.state.position).toBeGreaterThan(-140);
  });
  it('completes immediately for reduced motion without scheduling a spatial animation', () => {
    const f = fixture(); f.reduce(); f.motion.to(0, 600);
    expect(f.positions).toEqual([0]); expect(f.frames.size).toBe(0); expect(f.rests).toBe(1);
  });
  it('honors a reduced-motion change during an animation', () => {
    const f = fixture(); f.motion.to(0); f.advance(16); f.reduce(); f.advance(16);
    expect(f.motion.state).toEqual({ position: 0, velocity: 0 }); expect(f.frames.size).toBe(0);
  });
  it('cancels pending work on cleanup and leaves no subsequent writes', () => {
    const f = fixture(); f.motion.to(0); f.advance(16); f.motion.stop();
    const count = f.positions.length; f.advance(1000);
    expect(f.frames.size).toBe(0); expect(f.positions).toHaveLength(count);
  });
});
