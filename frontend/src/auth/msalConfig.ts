import { Configuration, LogLevel, BrowserCacheLocation } from '@azure/msal-browser';
import { RUNTIME_CONFIG } from '../runtime-config';

/**
 * MSAL Configuration
 *
 * Values are resolved from runtime config (window.__APP_CONFIG__) first,
 * falling back to Vite build-time env vars (import.meta.env.VITE_*).
 * The container entrypoint substitutes runtime values from App Service env
 * vars so the same published image works for every Entra tenant.
 */

const CLIENT_ID = RUNTIME_CONFIG.AZURE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';
const TENANT_ID = RUNTIME_CONFIG.AZURE_TENANT_ID || 'YOUR_TENANT_ID_HERE';
const AUTHORITY_HOST =
  RUNTIME_CONFIG.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com';

export const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: `${AUTHORITY_HOST}/${TENANT_ID}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: BrowserCacheLocation.SessionStorage,
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:   console.error(message); break;
          case LogLevel.Warning: console.warn(message); break;
          case LogLevel.Info:    console.info(message); break;
          case LogLevel.Verbose: console.debug(message); break;
        }
      },
      piiLoggingEnabled: false,
      logLevel: LogLevel.Warning,
    },
  },
};

/** Scopes requested during login — include openid/profile for user info */
export const loginRequest = {
  scopes: ['openid', 'profile', 'email'],
};

/** Scopes for calling the backend API */
export const apiRequest = {
  scopes: [
    RUNTIME_CONFIG.API_SCOPE || `api://${CLIENT_ID}/access_as_user`,
  ],
};
