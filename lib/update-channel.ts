import manifest from './update-channel-manifest.json';

// Release metadata is deployed with the site, independently of Auth, Storage,
// an account session or a per-request call to GitHub. Never proxy the binaries.
export function updateChannelResponse(file: string): Response {
  const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
  const platform = file === 'latest-windows.json' ? 'windows-x86_64'
    : file === 'latest-macos.json' ? 'macos-universal' : null;
  if (!platform && file !== 'latest.json') return new Response(null,{status:404,headers});
  return Response.json({...manifest,platforms:platform?{[platform]:manifest.platforms[platform]}:manifest.platforms},{headers});
}
