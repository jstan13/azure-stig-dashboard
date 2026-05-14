/**
 * Runtime configuration loader.
 *
 * In a containerized deployment (App Service running our public image) the
 * container entrypoint substitutes real values into /runtime-config.js from
 * App Service env vars, and that script populates `window.__APP_CONFIG__`
 * before main.tsx runs.
 *
 * During local `npm run dev` or `vite build` (no container), the placeholders
 * remain as `${VAR}` strings — we detect that and fall back to the build-time
 * `import.meta.env.VITE_*` values so local dev keeps working unchanged.
 */

declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string>;
  }
}

const raw =
  (typeof window !== 'undefined' && window.__APP_CONFIG__) || ({} as Record<string, string>);

/** True if the runtime value is missing or still an unsubstituted `${VAR}` placeholder. */
function isPlaceholder(v: string | undefined): boolean {
  if (!v) return true;
  // envsubst leaves unresolved variables as ${NAME} or empty strings
  return /^\$\{.*\}$/.test(v);
}

function pick(runtimeKey: string, buildValue: string | undefined): string {
  const r = raw[runtimeKey];
  if (!isPlaceholder(r)) return r;
  return buildValue ?? '';
}

export const RUNTIME_CONFIG = {
  AZURE_CLIENT_ID:      pick('AZURE_CLIENT_ID',      import.meta.env.VITE_AZURE_CLIENT_ID),
  AZURE_TENANT_ID:      pick('AZURE_TENANT_ID',      import.meta.env.VITE_AZURE_TENANT_ID),
  AZURE_CLOUD:          pick('AZURE_CLOUD',          import.meta.env.VITE_AZURE_CLOUD),
  AZURE_AUTHORITY_HOST: pick('AZURE_AUTHORITY_HOST', import.meta.env.VITE_AZURE_AUTHORITY_HOST),
  API_URL:              pick('API_URL',              import.meta.env.VITE_API_URL) || '/api',
  API_SCOPE:            pick('API_SCOPE',            import.meta.env.VITE_API_SCOPE),
  MOCK_MODE:            pick('MOCK_MODE',            import.meta.env.VITE_MOCK_MODE) === 'true',
};
