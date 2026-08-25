/**
 * useApi — Axios instance factory with MSAL token injection.
 *
 * In MOCK_MODE (VITE_MOCK_MODE=true) the hook skips token acquisition
 * so the app works without a real Azure AD tenant.
 */

import { useMsal } from '@azure/msal-react';
import axios, { AxiosInstance } from 'axios';
import { useEffect, useMemo, useRef } from 'react';
import { apiRequest } from '../auth/msalConfig';
import { RUNTIME_CONFIG } from '../runtime-config';

const MOCK_MODE = RUNTIME_CONFIG.MOCK_MODE;
const API_BASE = RUNTIME_CONFIG.API_URL;

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

      const { instance: msalInstance, accounts: msalAccounts } = msal.current;
      if (msalAccounts.length === 0) return config;

      try {
        const tokenResponse = await msalInstance.acquireTokenSilent({
          ...apiRequest,
          account: msalAccounts[0],
        });
        config.headers['Authorization'] = `Bearer ${tokenResponse.accessToken}`;
      } catch {
        // Token refresh failed — redirect to login
        await msalInstance.acquireTokenRedirect(apiRequest);
      }
      return config;
    });

    return api;
  }, []);
}

/** Convenience: bare Axios for mock/no-auth usage */
export const api = axios.create({ baseURL: API_BASE });
