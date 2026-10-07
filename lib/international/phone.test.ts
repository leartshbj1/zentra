import {describe,expect,it} from 'vitest';
import {formatContactPhone,normalizeContactPhone} from './phone';
describe('national contact phone presentation, without geographic verification',()=>{
 it.each(['2125550100','(212) 555-0100','1 212 555 0100','+1 (212) 555-0100'])('normalizes %s explicitly for US',input=>{expect(normalizeContactPhone(input,'US')).toBe('+12125550100');});
 it('formats NANP and Swiss international numbers',()=>{expect(formatContactPhone('+12125550100','US')).toBe('+1 (212) 555-0100');expect(normalizeContactPhone('022 555 01 00','CH')).toBe('+41225550100');expect(formatContactPhone('+41225550100','CH')).toBe('+41 22 555 01 00');});
 it('preserves international contact numbers without inferring nationality',()=>{expect(normalizeContactPhone('+41 22 555 01 00','US')).toBe('+41225550100');expect(formatContactPhone('+442079460000','US')).toBe('+442079460000');});
 it.each(['5550100','0125550100','2120550100','2125550100 ext 2','+1+2125550100','1e9','+0000000','000'])('refuses ambiguous %s',value=>{expect(()=>normalizeContactPhone(value,'US')).toThrow();});
});
