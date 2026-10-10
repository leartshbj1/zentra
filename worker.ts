import handler from 'vinext/server/fetch-handler';
import { withoutCallerScriptPolicy } from './lib/page-csp';
import { assertDeploymentRuntime, deploymentBindingReader } from './lib/deployment-contract';

const zentraWorker = {
  async scheduled(controller: ScheduledController, env: unknown) {
    // The existing CH mail relay remains independent. No cron is provisioned
    // here; an approved US deployment must explicitly opt in to this handler.
    return (await import('./lib/international/us-support-worker-bindings')).runUsSupportScheduled(controller, env);
  },
  fetch(request: Request, env: unknown, context: ExecutionContext) {
    try {
      assertDeploymentRuntime(deploymentBindingReader(env), request);
    } catch {
      return new Response('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH', { status: 503 });
    }
    return handler.fetch(withoutCallerScriptPolicy(request), env, context);
  },
};
export default zentraWorker;
