import { invoke } from '@tauri-apps/api/core';
export type FixedAsset = {id:string;name:string;reference:string;date:string;costCents:number;residualCents:number;rateBp:number;method:'linear'|'declining';mode:'purchase'|'reclassify';assetAccountId:string;depreciationAccountId:string;counterpartAccountId:string};
export type FixedAssetRow = {asset:FixedAsset;depreciatedCents:number;bookValueCents:number;cancelled:boolean;nextYear:number;nextAmountCents:number;blocker:string|null;history:{id:string;entry_date:string;amount_cents:number}[]};
export const fixedAssetsApi = {
  list:()=>invoke<{items:FixedAssetRow[]}>('list_fixed_assets'),
  register:(input:FixedAsset)=>invoke<{items:FixedAssetRow[]}>('register_fixed_asset',{input}),
  depreciate:(row:FixedAssetRow)=>invoke<{items:FixedAssetRow[]}>('depreciate_fixed_asset',{id:row.asset.id,year:row.nextYear,expected:row.nextAmountCents}),
  cancel:(id:string,date:string)=>invoke<{items:FixedAssetRow[]}>('cancel_fixed_asset',{id,date}),
};
// AFC A1995 commercial businesses: indicative book-value rates; acquisition
// value rates are half. The user confirms suitability for their canton/use.
export const assetPresets = [
  {id:'computer',name:'Informatique',declining:4000},
  {id:'furniture',name:'Mobilier',declining:2500},
  {id:'machine',name:'Machines',declining:3000},
  {id:'vehicle',name:'Véhicules',declining:4000},
];
