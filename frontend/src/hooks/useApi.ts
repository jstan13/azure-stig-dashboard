/**
 * The application's single Axios instance, with MSAL token injection.
 *
 * There is exactly one instance and one interceptor. Pages may import `api`
 * directly or call `useApi()` — both hand back the same object, so no page can
 * reach the API unauthenticated, and putting `api` in an effect dependency
 * array cannot loop the way a per-render instance did.
 *
 * In MOCK_MODE (VITE_MOCK_MODE=true) token acquisition is skipped so the app
 * works without a real Azure AD tenant.
 */

import axios, { AxiosInstance } from 'axios';
import { apiRequest, msalInstance } from '../auth/msalConfig';
import { RUNTIME_CONFIG } from '../runtime-config';

const MOCK_MODE = RUNTIME_CONFIG.MOCK_MODE;
const API_BASE = RUNTIME_CONFIG.API_URL;

/** How long a request waits for MSAL to finish restoring its cache. */
const ACCOUNT_WAIT_MS = 5_000;

/**
 * MSAL only publishes accounts once it has initialised and settled any redirect
 * it was in the middle of, which is later than the first paint — and pages load
 * their data from mount effects. Wait for that rather than racing it, so a
 * request is never sent during the window with no token to send.
 */
async function currentAccount() {
  await msalInstance.initialize();
  const deadline = Date.now() + ACCOUNT_WAIT_MS;
  for (;;) {
    const account = msalInstance.getAllAccounts()[0];
    if (account) return account;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

export const api: AxiosInstance = axios.create({ baseURL: API_BASE });

api.interceptors.request.use(async (config) => {
  if (MOCK_MODE) return config;

  const account = await currentAccount();
  if (!account) {
    throw new axios.CanceledError('Not signed in');
  }

  let tokenResponse;
  try {
    tokenResponse = await msalInstance.acquireTokenSilent({ ...apiRequest, account });
  } catch {
    await msalInstance.acquireTokenRedirect(apiRequest);
    // Letting it through would surface a 401 on top of the sign-in redirect.
    throw new axios.CanceledError('Signing in again');
  }

  config.headers['Authorization'] = `Bearer ${tokenResponse.accessToken}`;
  return config;
});

export function useApi(): AxiosInstance {
  return api;
}
