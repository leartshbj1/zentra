import handler from 'vinext/server/fetch-handler';
import { withoutCallerScriptPolicy } from './lib/page-csp';
import { assertDeploymentRuntime, deploymentBindingReader } from './lib/deployment-contract';

export default {
  fetch(request: Request, env: unknown, context: ExecutionContext) {
    try {
      assertDeploymentRuntime(deploymentBindingReader(env), request);
    } catch {
      return new Response('ZENTRA_DEPLOYMENT_PROFILE_MISMATCH', { status: 503 });
    }
    return handler.fetch(withoutCallerScriptPolicy(request), env, context);
  },
};
