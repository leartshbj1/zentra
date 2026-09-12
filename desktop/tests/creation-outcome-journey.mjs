import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ZENTRA_QA_URL || 'http://127.0.0.1:5271';
const output = '.qa/creation-outcome'; await mkdir(output, { recursive: true }); const report = [];
for (const [engine, driver] of [['edge', chromium], ['webkit', webkit]]) {
 const browser = await driver.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
 try { for (const [width, height] of [[320,568],[390,844],[844,390],[1440,1000]]) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  const state = key => page.evaluate(key => JSON.parse(sessionStorage.getItem(`qa-creation-${key}`) || '[]'), key);
  const fail = mode => page.evaluate(mode => sessionStorage.setItem('qa-creation-failure', mode), mode);
  const readable = () => page.evaluate(() => sessionStorage.removeItem('qa-creation-block-reads'));
  const navigate = async title => { await page.getByRole('button',{name:'Aller à un écran',exact:true}).click(); await page.getByRole('searchbox',{name:'Rechercher un écran'}).fill(title); await page.locator('.navigation-palette__results button').filter({has:page.getByText(title,{exact:true})}).click(); };
  const capture = async name => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.modal,.modal__body')].some(el => el.scrollWidth > el.clientWidth + 1)),false,`${engine} ${width} ${name}: overflow`); await page.screenshot({path:`${output}/${engine}-${width}-${name}.png`}); };
  try {
   await page.goto(`${base}/tests/mobile-harness.html?creationOutcome=1`);
   await page.getByRole('button',{name:'Fermer le guide automatique',exact:true}).click();
   await navigate('Clients');
   const newClient = async name => { await page.getByRole('button',{name:'Nouveau client',exact:true}).click(); const form=page.getByRole('dialog',{name:'Nouveau client',exact:true}); for (const [field,value] of Object.entries({company:name,street:'Rue du test',postalCode:'1000',city:'Lausanne',notes:'Ligne une\nLigne deux'})) await form.locator(`[name=${field}]`).fill(value); return form; };
   let form=await newClient('Réponse retrouvée');
   await fail('lost'); await form.getByRole('button',{name:'Enregistrer',exact:true}).click(); await form.waitFor({state:'hidden'});
   assert.equal((await state('writes')).length,1); assert.equal((await state('attempts')).length,1); await page.getByText('Le client a été ajouté.',{exact:true}).waitFor();
   form=await newClient('Vérification en attente'); await fail('lost-unreadable'); await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
   const recovery=page.getByRole('dialog',{name:'Vérifier l’enregistrement',exact:true}); await recovery.waitFor();
   assert.equal(await page.getByRole('dialog',{name:'Enregistrement effectué',exact:true}).count(),0);
   assert.equal((await state('attempts')).length,2);
   await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click(); await recovery.getByText('Vérification encore indisponible',{exact:true}).waitFor();
   await page.keyboard.press('Escape'); assert.ok(await recovery.isVisible());
   await page.keyboard.press('Tab'); assert.ok(await recovery.evaluate(el=>el.contains(document.activeElement)));
   assert.ok(await page.locator('.contact-form-modal').evaluate(el=>!!el.closest('[inert]')));
   assert.equal((await state('attempts')).length,2); await capture('pending');
   // An onboarding snapshot cannot prove that an uncertain creation was absent.
   await readable(); await page.evaluate(()=>sessionStorage.setItem('qa-creation-empty-onboarding','1')); await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click(); await recovery.getByText('La base de votre entreprise doit être accessible pour vérifier cet enregistrement.',{exact:true}).waitFor();
   await page.evaluate(()=>{sessionStorage.removeItem('qa-creation-empty-onboarding'); window.__qaSetReadOnly(true);});
   await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click(); await recovery.waitFor({state:'hidden'}); await form.waitFor({state:'hidden'});
   assert.equal((await state('attempts')).length,2); assert.equal((await state('store')).clients.length,2);
   await page.evaluate(()=>window.__qaSetReadOnly(false));
   form=await newClient('Validation refusée'); await fail('refused'); await form.getByRole('button',{name:'Enregistrer',exact:true}).click(); await form.getByText('La fiche n’a pas pu être enregistrée.',{exact:true}).waitFor(); await form.getByText('Voir le message complet',{exact:true}).click(); await form.getByText('Enregistrement refusé. Votre saisie est conservée.',{exact:true}).waitFor();
   assert.equal(await form.locator('[name=company]').inputValue(),'Validation refusée'); assert.equal((await state('writes')).length,2);
   await form.locator('[name=company]').fill('Client corrigé'); await form.getByRole('button',{name:'Enregistrer',exact:true}).click(); await form.waitFor({state:'hidden'}); assert.equal((await state('writes')).length,3);
   // A real refusal plus a failed read must also stay pending until its absence is verified.
   await navigate('Achats & fournisseurs'); if(width<=860)await page.getByRole('combobox',{name:'Section des achats',exact:true}).selectOption('suppliers');else await page.locator('#purchase-tab-suppliers').click();
   await page.getByRole('button',{name:'Nouveau fournisseur',exact:true}).click(); form=page.getByRole('dialog',{name:'Nouveau fournisseur',exact:true});
   await form.locator('[name=name]').fill('Fournisseur corrigé'); await form.locator('[name=iban]').fill('CH93 0076 2011 6238 5295 7'); await form.locator('[name=notes]').fill('Saisie à conserver');
   await fail('refused-unreadable'); await form.getByRole('button',{name:'Ajouter le fournisseur',exact:true}).click(); await recovery.waitFor();
   assert.equal((await state('store')).suppliers.length,0); const attemptsBefore=(await state('attempts')).length;
   await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click(); await recovery.getByText('Vérification encore indisponible',{exact:true}).waitFor(); assert.equal((await state('attempts')).length,attemptsBefore);
   await readable(); await recovery.getByRole('button',{name:'Vérifier maintenant',exact:true}).click(); await recovery.waitFor({state:'hidden'}); await form.getByText(/L’IBAN a été refusé/).waitFor();
   assert.equal(await form.locator('[name=notes]').inputValue(),'Saisie à conserver'); await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='iban'); await capture('correctable');
   await form.locator('[name=iban]').fill(''); await form.getByRole('button',{name:'Ajouter le fournisseur',exact:true}).click(); await form.waitFor({state:'hidden'});
   assert.equal((await state('store')).suppliers.length,1); assert.equal((await state('attempts')).length,attemptsBefore+1);
   const supplierAttempts=(await state('attempts')).filter(row=>row.entity==='suppliers'); assert.notEqual(supplierAttempts[0].data.id,supplierAttempts[1].data.id);
   assert.equal(supplierAttempts[1].data.iban,'');
   // Acknowledged writes retain the existing saved/refresh language.
   await navigate('Clients'); form=await newClient('Confirmé'); await fail('confirmed-unreadable'); await form.getByRole('button',{name:'Enregistrer',exact:true}).click();
   const saved=page.getByRole('dialog',{name:'Enregistrement effectué',exact:true}); await saved.waitFor(); await readable(); await saved.getByRole('button',{name:'Actualiser les données',exact:true}).click(); await form.waitFor({state:'hidden'});
   await page.reload(); await navigate('Clients'); await page.locator('strong').filter({hasText:'Client corrigé'}).waitFor(); assert.equal((await state('store')).clients.length,4); assert.equal((await state('writes')).length,5);
   assert.deepEqual(errors,[]); report.push({engine,width,height,result:'PASS production bridge, lost response found, unknown outcome locked, read-only verification, invalid onboarding blocked, refusal corrected without duplicate, acknowledged refresh, persisted records'});
  }catch(error){await page.screenshot({path:`${output}/${engine}-${width}-failure.png`});await writeFile(`${output}/${engine}-${width}-failure.html`,await page.content());await writeFile(`${output}/${engine}-${width}-errors.json`,JSON.stringify(errors));throw error;}finally{await page.close();}
 }}catch(error){report.push({engine,fatal:error.stack});process.exitCode=1;}finally{await browser.close();}
}
await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
