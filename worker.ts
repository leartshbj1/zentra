import handler from 'vinext/server/fetch-handler';
import { withoutCallerScriptPolicy } from './lib/page-csp';

export default {
  fetch(request: Request, env: unknown, context: ExecutionContext) {
    return handler.fetch(withoutCallerScriptPolicy(request), env, context);
  },
};
