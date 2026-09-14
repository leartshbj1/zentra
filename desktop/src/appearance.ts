import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
export type Appearance = 'system' | 'light' | 'dark';
const key = 'zentra.appearance.v1';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const valid = (value: unknown): value is Appearance => ['system','light','dark'].includes(String(value));
let preference: Appearance = 'system';
try {const value=localStorage.getItem(key);if(valid(value))preference=value;} catch { /* Session preference remains available. */ }
const listeners = new Set<()=>void>();
let pendingNativeTheme: { appearance: Appearance; dark: boolean } | undefined;
let applyingNativeTheme = false;
async function syncNativeTheme(appearance: Appearance, dark: boolean) {
  if (!isTauri()) return;
  pendingNativeTheme = { appearance, dark };
  if (applyingNativeTheme) return;
  applyingNativeTheme = true;
  try {
    // Native calls can complete after a later click. Serialize them and keep
    // only the latest pending choice so the window finishes on the UI theme.
    while (pendingNativeTheme) {
      const next = pendingNativeTheme;
      pendingNativeTheme = undefined;
      try { await invoke('set_app_appearance', next); } catch { /* Web appearance remains usable. */ }
    }
  } finally { applyingNativeTheme = false; }
}
function apply() {
  const dark=preference==='dark'||preference==='system'&&media.matches;
  document.documentElement.dataset.appTheme=dark?'dark':'light';
  document.documentElement.style.colorScheme=dark?'dark':'light';
  document.documentElement.style.backgroundColor=dark?'#141416':'#f5f5f7';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#141416':'#f5f5f7');
  void syncNativeTheme(preference,dark);
  listeners.forEach(notify=>notify());
}
export function setAppearance(value:Appearance) {if(!valid(value))return false;preference=value;let saved=true;try{localStorage.setItem(key,value);}catch{saved=false;}apply();return saved;}
export function useAppearance(){return useSyncExternalStore(notify=>{listeners.add(notify);return()=>{listeners.delete(notify);};},()=>preference);}
media.addEventListener('change',()=>{if(preference==='system')apply();});
window.addEventListener('storage',event=>{if(event.key===key||event.key===null){preference=valid(event.newValue)?event.newValue:'system';apply();}});
apply();
