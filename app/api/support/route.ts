import {
  getWorkspaceState,
  getPlatformState,
  mutateWorkspace,
  supportError,
} from '@/lib/support/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get('admin') === '1')
      return await getPlatformState();
    return await getWorkspaceState(request);
  } catch (error) {
    return supportError(error);
  }
}
export async function POST(request: Request) {
  try {
    return await mutateWorkspace(request);
  } catch (error) {
    return supportError(error);
  }
}
