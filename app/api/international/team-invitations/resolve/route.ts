import { usTeamHandlers } from '@/lib/international/us-team-bindings';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>usTeamHandlers.resolve(request);
