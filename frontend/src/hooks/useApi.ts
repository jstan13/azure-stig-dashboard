/**
 * useApi — Axios instance factory with MSAL token injection.
 *
 * In MOCK_MODE (VITE_MOCK_MODE=true) the hook skips token acquisition
 * so the app works without a real Azure AD tenant.
 */

import { useMsal } from '@azure/msal-react';
import type { IPublicClientApplication } from '@azure/msal-browser';
import axios, { AxiosInstance } from 'axios';
import { useEffect, useMemo, useRef } from 'react';
import { apiRequest } from '../auth/msalConfig';
import { RUNTIME_CONFIG } from '../runtime-config';

const MOCK_MODE = RUNTIME_CONFIG.MOCK_MODE;
const API_BASE = RUNTIME_CONFIG.API_URL;

/** How long a request will wait for MSAL to finish restoring its cache. */
const ACCOUNT_WAIT_MS = 5_000;

/**
 * MSAL populates `useMsal().accounts` only after its redirect promise settles,
 * which is later than the first paint — and pages fire their loads from mount
 * effects. Ask the instance directly so a request is never sent during that
 * window with no token, which the API can only answer with a 401.
 */
async function currentAccount(instance: IPublicClientApplication) {
  const deadline = Date.now() + ACCOUNT_WAIT_MS;
  for (;;) {
    const account = instance.getAllAccounts()[0];
    if (account) return account;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

export function useApi(): AxiosInstance {
  const { instance, accounts } = useMsal();

  // The interceptor reads MSAL through this ref so the axios instance itself
  // can stay referentially stable. Pages put `api` in effect dependency arrays;
  // handing back a fresh instance every render turned those into render loops
  // that never stopped fetching.
  const msal = useRef({ instance, accounts });
  useEffect(() => { msal.current = { instance, accounts }; }, [instance, accounts]);

  return useMemo(() => {
    const api = axios.create({ baseURL: API_BASE });

    api.interceptors.request.use(async (config) => {
      if (MOCK_MODE) return config;

      const msalInstance = msal.current.instance;
      const account = await currentAccount(msalInstance);
      if (!account) {
        throw new axios.CanceledError('Not signed in');
      }

      let tokenResponse;
      try {
        tokenResponse = await msalInstance.acquireTokenSilent({ ...apiRequest, account });
      } catch {
        await msalInstance.acquireTokenRedirect(apiRequest);
        // Sending it unauthenticated would surface a 401 over the redirect.
        throw new axios.CanceledError('Signing in again');
      }
      config.headers['Authorization'] = `Bearer ${tokenResponse.accessToken}`;
      return config;
    });

    return api;
  }, []);
}

/** Convenience: bare Axios for mock/no-auth usage */
export const api = axios.create({ baseURL: API_BASE });
