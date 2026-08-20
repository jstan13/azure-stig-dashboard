/**
 * useApi — Axios instance factory with MSAL token injection.
 *
 * In MOCK_MODE (VITE_MOCK_MODE=true) the hook skips token acquisition
 * so the app works without a real Azure AD tenant.
 */

import { useMsal } from '@azure/msal-react';
import axios, { AxiosInstance } from 'axios';
import { useCallback } from 'react';
import { apiRequest } from '../auth/msalConfig';
import { RUNTIME_CONFIG } from '../runtime-config';

const MOCK_MODE = RUNTIME_CONFIG.MOCK_MODE;
const API_BASE = RUNTIME_CONFIG.API_URL;

export function useApi(): AxiosInstance {
  const { instance, accounts } = useMsal();

  const getAxios = useCallback(() => {
    const api = axios.create({ baseURL: API_BASE });

    api.interceptors.request.use(async (config) => {
      if (MOCK_MODE) return config;

      if (accounts.length === 0) return config;

      try {
        const tokenResponse = await instance.acquireTokenSilent({
          ...apiRequest,
          account: accounts[0],
        });
        config.headers['Authorization'] = `Bearer ${tokenResponse.accessToken}`;
      } catch {
        // Token refresh failed — redirect to login
        await instance.acquireTokenRedirect(apiRequest);
      }
      return config;
    });

    return api;
  }, [instance, accounts]);

  return getAxios();
}

/** Convenience: bare Axios for mock/no-auth usage */
export const api = axios.create({ baseURL: API_BASE });
