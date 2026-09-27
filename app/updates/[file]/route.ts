import { updateChannelResponse } from '@/lib/update-channel';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: {params:Promise<{file:string}>}) {
  const {file} = await context.params;
  return updateChannelResponse(file);
}
