import {describe,expect,it} from 'vitest';
import {employeeDraftFields,validEmployeeCreationId,validCreationEmployeeDraft,employeeCreationRecovery,EMPLOYEE_LOCAL_DRAFT_UNSAVED} from './employeeCreationDraft';

describe('employee durable draft boundary',()=>{
  it('keeps the 43 existing business fields unique and never includes a password or a nonce',()=>{expect(employeeDraftFields).toHaveLength(43);expect(new Set(employeeDraftFields).size).toBe(43);expect(employeeDraftFields.join(' ')).not.toMatch(/password|memberContextNonce|token/i);});
  it('accepts a strict UUID and a readable legacy value that still requires the real explicit UI decision',()=>{expect(validEmployeeCreationId('12345678-abcd-4abc-8def-1234567890ab')).toBe(true);expect(validCreationEmployeeDraft({creationId:'12345678-abcd-4abc-8def-1234567890ab'})).toBe(true);expect(validCreationEmployeeDraft({name:'Legacy employee'})).toBe(true);});
  it.each(['','not-a-uuid',' 12345678-abcd-4abc-8def-1234567890ab','12345678-abcd-4abc-8def-1234567890ab ','12345678-abcd-4abc-8def-1234567890az'])('rejects malformed creation ID %j',value=>{expect(validEmployeeCreationId(value)).toBe(false);expect(validCreationEmployeeDraft({creationId:value})).toBe(false);});
  it('uses one language-independent storage sentinel and complete guides for all four languages',()=>{expect(EMPLOYEE_LOCAL_DRAFT_UNSAVED).toBe('employee-local-draft-unsaved');expect(Object.keys(employeeCreationRecovery)).toEqual(['fr','de','it','en']);for(const guide of Object.values(employeeCreationRecovery))for(const value of Object.values(guide))expect(value.length).toBeGreaterThan(15);});
});
