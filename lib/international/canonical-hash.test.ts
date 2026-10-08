import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex as legacyHash } from '../account-security';
import { sha256Hex } from './canonical-hash';
describe('pure canonical ERP hash compatibility',()=>{
  it.each([{name:'empty',value:''},{name:'ASCII',value:'abc'},{name:'canonical command',value:'["org","user",{"command":{"type":"initialize"}}]'},{name:'Unicode',value:'Énergie — 東京\n😀'},{name:'long canonical value',value:'0'.repeat(300_000)}])('keeps exact legacy and SHA-256 bytes: $name',async ({value})=>{expect(await sha256Hex(value)).toBe(await legacyHash(value));expect(await sha256Hex(value)).toBe(createHash('sha256').update(value,'utf8').digest('hex'));});
  it('copies binary input and preserves byte subarray boundaries',async()=>{const bytes=new Uint8Array([255,0,128,33,42]);const value=bytes.subarray(1,4);expect(await sha256Hex(value)).toBe(createHash('sha256').update(value).digest('hex'));expect(bytes).toEqual(new Uint8Array([255,0,128,33,42]));});
});
