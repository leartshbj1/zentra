import {desktopApi} from '../src/bridge';
import type {Workspace} from '../src/types';
export function installClarityFixture(workspace:Workspace){
 const qa={settingsWrites:[] as Workspace['settings'][],vatWrites:[] as unknown[],failSave:false,failVat:false};
 Object.assign(window,{__clarityQA:qa});
 desktopApi.saveSettings=async settings=>{
  await new Promise(resolve=>setTimeout(resolve,60));
  if(qa.failSave)throw new Error('Échec de recette : vos choix sont conservés.');
  qa.settingsWrites.push(structuredClone(settings));workspace.settings=structuredClone(settings);
  return structuredClone(workspace);
 };
 desktopApi.createVatProfile=async input=>{
  await new Promise(resolve=>setTimeout(resolve,60));
  if(qa.failVat)throw new Error('La configuration TVA de recette a été refusée.');
  qa.vatWrites.push(structuredClone(input));return {...input,id:'clarity-vat',effectiveTo:input.effectiveTo||null,grossOrNet:input.grossOrNet||'net',tdfnActivityId:input.tdfnActivityId||null,tdfnRateBp:input.tdfnRateBp??null,notes:input.notes||'',createdAt:'2026-09-10',updatedAt:'2026-09-10'};
 };
}
