// Real standalone ProjectFolder; only its data transport is synthetic.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectFolder } from '../src/ProjectFolder';
import { desktopApi } from '../src/bridge';

export async function mountProjectFileScopeFixture() {
  const initial = await desktopApi.loadWorkspace();
  const harness = document.getElementById('root');
  if (harness) harness.hidden = true;
  const container = document.createElement('div');
  container.id = 'project-file-scope-standalone';
  document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const [workspace, setWorkspace] = useState(initial);
    return <ProjectFolder project={workspace.projects[0]} workspace={workspace} busy={false} readOnly={false}
      onBack={() => {}} onOpenDocument={() => {}} onCreateDocument={() => {}} onWorkspaceChange={setWorkspace} />;
  }
  root.render(<Fixture />);
  return { dispose() { root.unmount(); container.remove(); if (harness) harness.hidden = false; } };
}
