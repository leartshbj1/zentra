import {
  getWorkspaceState,
  mutateWorkspace,
  supportError,
} from '@/lib/support/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
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
