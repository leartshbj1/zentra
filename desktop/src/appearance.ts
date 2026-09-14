import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
export type Appearance = 'system' | 'light' | 'dark';
const key = 'zentra.appearance.v1';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const valid = (value: unknown): value is Appearance => ['system','light','dark'].includes(String(value));
let preference: Appearance = 'system';
try {const value=localStorage.getItem(key);if(valid(value))preference=value;} catch { /* Session preference remains available. */ }
const listeners = new Set<()=>void>();
function apply() {
  const dark=preference==='dark'||preference==='system'&&media.matches;
  document.documentElement.dataset.appTheme=dark?'dark':'light';
  document.documentElement.style.colorScheme=dark?'dark':'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#131619':'#f5f5f7');
  if(isTauri())void invoke('set_app_appearance',{appearance:preference,dark}).catch(()=>{});
  listeners.forEach(notify=>notify());
}
export function setAppearance(value:Appearance) {if(!valid(value))return false;preference=value;let saved=true;try{localStorage.setItem(key,value);}catch{saved=false;}apply();return saved;}
export function useAppearance(){return useSyncExternalStore(notify=>{listeners.add(notify);return()=>{listeners.delete(notify);};},()=>preference);}
media.addEventListener('change',()=>{if(preference==='system')apply();});
window.addEventListener('storage',event=>{if(event.key===key){preference=valid(event.newValue)?event.newValue:'system';apply();}});
apply();
