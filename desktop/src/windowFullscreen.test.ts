import { describe, expect, it } from 'vitest';
import { fullscreenAction } from './windowFullscreen';

const key = (values: Partial<KeyboardEvent>) => ({ key: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, repeat: false, ...values });
describe('full screen shortcuts', () => {
  it('switches with F11 alone', () => {
    expect(fullscreenAction(key({ key: 'F11' }), false, false)).toBe('toggle');
    expect(fullscreenAction(key({ key: 'F11', ctrlKey: true }), false, false)).toBeNull();
    expect(fullscreenAction(key({ key: 'F11', repeat: true }), false, false)).toBeNull();
  });
  it('leaves with Échap only when full screen and nothing else uses it', () => {
    expect(fullscreenAction(key({ key: 'Escape' }), true, false)).toBe('exit');
    expect(fullscreenAction(key({ key: 'Escape' }), false, false)).toBeNull();
    expect(fullscreenAction(key({ key: 'Escape' }), true, true)).toBeNull();
    expect(fullscreenAction(key({ key: 'Escape', defaultPrevented: true }), true, false)).toBeNull();
  });
});
