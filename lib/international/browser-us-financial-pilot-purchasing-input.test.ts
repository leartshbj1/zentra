import {describe,expect,it} from 'vitest';
import {purchasingAmount,purchasingTotal,purchasingDecimal} from './browser-us-financial-pilot-purchasing-input';
describe('exact manual purchasing inputs',()=>{
  it.each([['0','0'],['0.00','0'],['0.01','1'],['1.2','120'],['1000000000000000000000000000000000.01','100000000000000000000000000000000001']])('parses %s exactly',(draft,minor)=>expect(purchasingAmount(draft)).toBe(minor));
  it.each(['',' ','-1','+1','01','1,2','1e2','NaN','1.001','1.','10000000000000000000000000000000000'])('refuses %s',value=>expect(()=>purchasingAmount(value)).toThrow('invalid_purchasing_input'));
  it('requires explicit tax and positive bounded total',()=>{expect(()=>purchasingTotal('1','')).toThrow();expect(()=>purchasingTotal('0','0')).toThrow();expect(purchasingTotal('120.40','8.25')).toBe('12865');expect(()=>purchasingAmount('0',true)).toThrow();});
  it('formats exact draft strings without floating point',()=>{expect(purchasingDecimal('999999999999999999999999999999999999')).toBe('9999999999999999999999999999999999.99');});
});
