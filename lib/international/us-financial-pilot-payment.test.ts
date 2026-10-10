import {describe,expect,it} from 'vitest';
import {parseUsFinancialPilotPaymentAmount} from './us-financial-pilot-payment';
describe('pilot exact decimal payment entry',()=>{
  it.each([['10,50','1050'],['10.50','1050'],[' 10,5 ','1050'],['0,01','1'],['100','10000'],['9999999999999999999999999999999999.99','999999999999999999999999999999999999']])('accepts an ungrouped amount %s without float or rounding',(input,expected)=>expect(parseUsFinancialPilotPaymentAmount(input)).toBe(expected));
  it.each(['','0','0,00','-1','+1','01.00','1,234','1.234','1,234.56','1.234,56','1 234,56','1e3','NaN','Infinity','1,,5','1..5','1.','1,','10000000000000000000000000000000000','10\u0000'])('rejects ambiguous or unsupported input %s',input=>expect(()=>parseUsFinancialPilotPaymentAmount(input)).toThrow('invalid_financial_pilot_request'));
});
