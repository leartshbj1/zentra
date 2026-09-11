import { payrollLocalAi } from '../src/payrollLocalAi';
export function installAssistantFixture() {
  const calls: unknown[]=[];let installed=false;
  Object.assign(window,{assistantCalls:calls});
  payrollLocalAi.inspectModel=async()=>installed;
  payrollLocalAi.load=async()=>{installed=true;return 'wasm';};
  payrollLocalAi.removeModel=async()=>{installed=false;};
  payrollLocalAi.chat=async input=>{calls.push(input);await new Promise(resolve=>setTimeout(resolve,80));return {output:'Ouvrez le plan LPP pour vérifier le contrat de votre caisse, puis revenez au salaire.',source:'guide',truncated:false};};
}
