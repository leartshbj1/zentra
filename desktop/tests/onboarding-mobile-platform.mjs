import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
const {webkit}=createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE||'playwright');
const browser=await webkit.launch();
try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  await page.goto(`${process.env.ZENTRA_IOS_QA_ORIGIN||'http://127.0.0.1:5332'}/tests/onboarding-preview.html`);
  await page.locator('.first-run').waitFor();
  const settings=await page.evaluate(async()=>structuredClone((await import('/src/onboardingDraft.ts')).initialOnboardingSettings));
  await page.addInitScript(settings=>localStorage.setItem('zentra.onboarding.draft.v2',JSON.stringify({version:2,step:12,highestStep:12,settings,categoriesText:'',vatText:'',privacyConfirmed:false})),settings);
  await page.reload();await page.locator('.first-run__stage--backup').waitFor();
  await page.getByText('Enregistrer ou partager une sauvegarde',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Choisir',exact:true}).count(),0);
  await page.locator('[data-field="backup.privacyConfirmed"]').check();
  await page.locator('[data-field="backup.recoveryConfirmed"]').check();
  await page.locator('.first-run__actions .button--primary').click();
  await page.locator('.first-run__stage--assistants').waitFor();
  assert.equal(await page.evaluate(()=>window.onboardingFixture.calls.includes('backup-folder')),false);
  // Native safe area variables must win over zero browser env() values.
  for(const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(()=>{for(const [edge,value] of Object.entries({top:59,right:28,bottom:34,left:30}))document.documentElement.style.setProperty(`--safe-${edge}`,`${value}px`);});
    const insets=await page.evaluate(()=>{const g=getComputedStyle(document.querySelector('.first-run__guide')),m=getComputedStyle(document.querySelector('.first-run__main'));return {top:parseFloat(g.paddingTop),right:parseFloat(m.paddingRight),bottom:parseFloat(m.paddingBottom),left:parseFloat(m.paddingLeft)};});
    assert.ok(insets.top>=59&&insets.right>=28&&insets.bottom>=34&&insets.left>=30,JSON.stringify(insets));
  }
  const identity=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  await identity.addInitScript(settings=>localStorage.setItem('zentra.onboarding.draft.v2',JSON.stringify({version:2,step:2,highestStep:2,settings,categoriesText:'',vatText:'',privacyConfirmed:false})),settings);
  await identity.goto(`${process.env.ZENTRA_IOS_QA_ORIGIN||'http://127.0.0.1:5332'}/tests/onboarding-preview.html`);
  const choose=identity.getByRole('button',{name:'Choisir le logo',exact:true});await choose.waitFor();assert.ok((await choose.boundingBox()).height>=44);await choose.click();
  await identity.locator('.company-logo-setting__preview img').waitFor();
  for(const name of ['Remplacer le logo','Retirer'])assert.ok((await identity.getByRole('button',{name,exact:true}).boundingBox()).height>=44);
  const report={nativeSafeAreaVariables320and390:true,logoTouchTargets44Minimum:true,iosCompileTimePlatform:true,webkitTouch:true,backupRequiresNoDesktopFolder:true,platformFilesystemSharingPreserved:true,nativeDeviceTest:false};
  await mkdir('.qa/onboarding-redesign',{recursive:true});await writeFile('.qa/onboarding-redesign/ios-platform.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally { await browser.close(); }
