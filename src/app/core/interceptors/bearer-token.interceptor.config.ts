import { createInterceptorCondition, IncludeBearerTokenCondition } from 'keycloak-angular';
import { environment } from '../../../environments/environment';

/**
 * Configuration for `includeBearerTokenInterceptor` (registered in
 * app.config.ts). Attaches `Authorization: Bearer <access_token>` only to
 * requests whose URL matches our own future NestJS API origin.
 *
 * No backend exists yet — nothing calls `environment.apiUrl` today — but
 * once one does, its requests will be authenticated automatically without
 * any component needing to know about Keycloak.
 *
 * Explicit URL matching (rather than "attach to every request") prevents
 * leaking the access token to unrelated third-party origins.
 */
export const bearerTokenInterceptorConfig: IncludeBearerTokenCondition[] = [
  createInterceptorCondition<IncludeBearerTokenCondition>({
    urlPattern: new RegExp(`^${escapeRegExp(environment.apiUrl)}(/.*)?$`)
  })
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
