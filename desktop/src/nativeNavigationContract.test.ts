import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { availableShortcuts, navigationIds, parseWorkspacePreferences, selectedShortcut } from './workspacePreferences';

// This is a source contract across the actual frontend and native definitions,
// not execution of UIKit or the Rust branch compiled only for iOS.
const rust = readFileSync(new URL('../plugins/zentra-mobile/src/lib.rs', import.meta.url), 'utf8');
const swift = readFileSync(new URL('../plugins/zentra-mobile/ios/Sources/ZentraMobilePlugin.swift', import.meta.url), 'utf8');
const glass = readFileSync(new URL('../plugins/zentra-mobile/ios/Sources/GlassNavigation.swift', import.meta.url), 'utf8');

function quotedValues(body: string | undefined, label: string) {
  expect(body, `Cannot locate ${label}; update the contract extractor if its definition moved.`).toBeDefined();
  return [...body!.matchAll(/"([^"\\]*)"/g)].map(match => match[1]);
}
function nativeDefinitions() {
  const rustGuard = rust.match(/if\s*!\s*\[([\s\S]*?)\]\s*\.contains\(&selected\.as_str\(\)\)\s*\{\s*return\s+Err\("Navigation inconnue"\.into\(\)\);\s*\}/);
  const swiftList = swift.match(/@objc\s+func\s+configureNavigation[\s\S]*?let\s+allowed\s*=\s*\[([\s\S]*?)\]/);
  const symbolDictionary = glass.match(/private\s+let\s+symbols\s*=\s*\[([\s\S]*?)\]/);
  expect(symbolDictionary, 'Cannot locate the actual GlassNavigation symbol dictionary.').not.toBeNull();
  const symbols = new Map([...symbolDictionary![1].matchAll(/"([^"\\]+)"\s*:\s*"([^"\\]+)"/g)].map(match => [match[1], match[2]]));
  return { rustIds: quotedValues(rustGuard?.[1], 'Rust selected guard'), swiftIds: quotedValues(swiftList?.[1], 'Swift allowed destinations'), symbols };
}

describe('iOS navigation contract across frontend, Rust and Swift', () => {
  it('accepts every configurable frontend destination and menu in both native layers with a dedicated symbol', () => {
    const expected = [...navigationIds, 'menu'].sort();
    const { rustIds, swiftIds, symbols } = nativeDefinitions();
    expect([...rustIds].sort()).toEqual(expected);
    expect([...swiftIds].sort()).toEqual(expected);
    expect([...symbols.keys()].sort()).toEqual(expected);
    expect([...symbols.values()].every(symbol => symbol.trim().length > 0)).toBe(true);
  });

  it('allows the Notes destination produced by the real personalized-shortcut selection', () => {
    const preferences = parseWorkspacePreferences(JSON.stringify({ version: 1, shortcuts: ['notes', 'agenda', 'projects', 'quotes'] }));
    const selected = selectedShortcut('notes', availableShortcuts(preferences, false));
    const { rustIds, swiftIds, symbols } = nativeDefinitions();
    expect(selected).toBe('notes');
    expect(rustIds).toContain(selected);
    expect(swiftIds).toContain(selected);
    expect(symbols.get(selected)).toBeTruthy();
  });

  it('keeps unknown destinations rejected before the native navigation is configured', () => {
    const { rustIds, swiftIds, symbols } = nativeDefinitions();
    for (const unknown of ['unknown-destination', '../notes', 'notes|command', 'notes\u0000']) {
      expect(rustIds).not.toContain(unknown);
      expect(swiftIds).not.toContain(unknown);
      expect(symbols.has(unknown)).toBe(false);
      const preferences = parseWorkspacePreferences(JSON.stringify({ version: 1, shortcuts: [unknown] }));
      expect(preferences.shortcuts).not.toContain(unknown);
    }
    expect(swift).toMatch(/guard\s+allowed\.contains\(args\.selected\)\s+else\s*\{\s*invoke\.reject\("Navigation inconnue"\);\s*return\s*\}/);
    expect(rust.indexOf('return Err("Navigation inconnue"')).toBeLessThan(rust.indexOf('.run_mobile_plugin_async('));
    expect(swift.indexOf('invoke.reject("Navigation inconnue")')).toBeLessThan(swift.indexOf('DispatchQueue.main.async'));
  });
});
