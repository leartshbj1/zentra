import { Building2, ChevronRight } from 'lucide-react';
import type { AccountWorkspace } from '@/lib/account-workspaces';
import { accountWorkspaceDestination } from '@/lib/account-workspace-navigation';
import { accountWorkspaceCopy, accountWorkspaceRole } from '@/lib/account-workspace-copy';
import type { SiteLanguage } from '@/lib/site-language';
export function WorkspacePicker({workspaces,language,unavailable=false}:{workspaces:readonly AccountWorkspace[];language:SiteLanguage;unavailable?:boolean}) {
  const c=accountWorkspaceCopy[language];
  return <><h1>{c.title}</h1><p className="account-lead">{c.lead}</p>
    {unavailable?<section className="account-card" role="alert"><h2>{c.unavailable}</h2><a className="account-button secondary" href="/compte/espaces">{c.retry}</a></section>
    :!workspaces.length?<section className="account-card account-empty"><h2>{c.empty}</h2><p>{c.emptyDetail}</p></section>
    :<ul className="account-space-list" aria-label={c.spaces}>{workspaces.map(workspace=><li key={`${workspace.edition}:${workspace.organizationId}`}><a className="account-space-choice" href={accountWorkspaceDestination(workspace)}><span className="account-space-icon" aria-hidden="true"><Building2 size={24}/></span><span className="account-space-name"><strong>{workspace.name}</strong><span className="account-space-metadata"><span>{workspace.edition==='ch_legacy'?c.ch:c.us}</span><span>{accountWorkspaceRole(language,workspace.role)}</span></span></span><span className="account-space-open">{c.open}<ChevronRight size={18} aria-hidden="true"/></span></a></li>)}</ul>}
  </>;
}
