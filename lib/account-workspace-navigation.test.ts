import {describe,it,expect} from 'vitest';
import {accountWorkspaceDestination,accountUsNavigation} from './account-workspace-navigation';
import {accountWorkspaceCopy} from './account-workspace-copy';
const id='10000000-0000-4000-8000-000000000001';
describe('country-specific workspace destinations',()=>{
 it('keeps Swiss company URLs and encodes their historical identifier',()=>expect(accountWorkspaceDestination({organizationId:'historical/company?x=1',edition:'ch_legacy'})).toBe('/compte/entreprise?organizationId=historical%2Fcompany%3Fx%3D1'));
 it('never retains a Swiss path or query for US',()=>expect(accountWorkspaceDestination({organizationId:id,edition:'us_experimental'})).toBe(`/compte/espaces/us/${id}`));
 it.each(['','/download','../../equipe','10000000-0000-4000-8000-00000000000Z',id.toUpperCase().replace('1000','ABCD')])('refuses malformed US identifier %s',organizationId=>expect(()=>accountWorkspaceDestination({organizationId,edition:'us_experimental'})).toThrow());
 it('accepts the same UUID versions as server admission',()=>expect(accountWorkspaceDestination({organizationId:id.replace('-4000-','-7000-'),edition:'us_experimental'})).toContain('-7000-'));
 it.each(['/compte/espaces/us','/compte/espaces/us/invalid','/compte/espaces/us/'+id+'/equipe','/compte/espaces/us/'+id+'?organizationId=ch'])('keeps malformed US routes away from Swiss fallback %s',pathname=>expect(accountUsNavigation(pathname)).toEqual({isUs:true,destination:null}));
 it('does not change Swiss navigation',()=>expect(accountUsNavigation('/compte/entreprise')).toEqual({isUs:false,destination:null}));
 it('has complete identical copy keys in all four languages',()=>{
  for(const language of ['en','de','it'] as const){expect(Object.keys(accountWorkspaceCopy[language]).sort()).toEqual(Object.keys(accountWorkspaceCopy.fr).sort());expect(Object.keys(accountWorkspaceCopy[language].roles).sort()).toEqual(Object.keys(accountWorkspaceCopy.fr.roles).sort());}
 });
});
