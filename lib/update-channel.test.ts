import {expect,it,vi} from 'vitest';
import {updateChannelResponse} from './update-channel';
import {GET} from '@/app/updates/[file]/route';
import {ZENTRA_WINDOWS_VERSION,ZENTRA_MAC_VERSION} from './downloads';

it.each([
  ['latest-windows.json',['windows-x86_64']],
  ['latest-macos.json',['macos-universal']],
  ['latest.json',['macos-universal','windows-x86_64']],
] as const)('serves %s anonymously without account storage or external calls',async(file,platforms)=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External services unavailable'));
  try {
    const response=await GET(new Request(`https://zentraapp.ch/updates/${file}`),{params:Promise.resolve({file})});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body=await response.json() as {version:string;platforms:Record<string,{url:string;signature:string}>};
    expect(Object.keys(body.platforms).sort()).toEqual(platforms);
    expect(body.version).toBe(ZENTRA_WINDOWS_VERSION);
    expect(body.version).toBe(ZENTRA_MAC_VERSION);
    for(const [target,value] of Object.entries(body.platforms) as [string,{url:string,signature:string}][]) {
      const name=target==='windows-x86_64'?`Zentra_${body.version}_x64-setup.exe`:`Zentra_${body.version}_macos-universal.app.tar.gz`;
      expect(value.url).toBe(`https://github.com/leartshbj1/zentra/releases/download/v${body.version}/${name}`);
      const signature=Buffer.from(value.signature,'base64').toString('utf8').trim().split('\n');
      expect(signature).toHaveLength(4);
      expect(signature[0]).toContain('untrusted comment:');
      expect(signature[2]).toContain(`file:${name}`);
    }
    expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
});
it.each(['latest-linux.json','../latest.json','LATEST.JSON','constructor','__proto__','https://attacker.test/file'])('refuses unknown channel %s',async(file)=>{
  const response=updateChannelResponse(file);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe('');
});
