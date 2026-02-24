import { Configuration, LogLevel, BrowserCacheLocation } from '@azure/msal-browser';

/**
 * MSAL Configuration
 *
 * Values are injected at build time via Vite environment variables.
 * Set these in your .env file (see sample.env):
 *   VITE_AZURE_CLIENT_ID   — Azure AD app registration client ID
 *   VITE_AZURE_TENANT_ID   — Azure AD tenant ID
 *   VITE_API_SCOPE         — API scope (e.g. api://<client-id>/access_as_user)
 */

const CLIENT_ID = import.meta.env.VITE_AZURE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';
const TENANT_ID = import.meta.env.VITE_AZURE_TENANT_ID || 'YOUR_TENANT_ID_HERE';

export const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
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
    import.meta.env.VITE_API_SCOPE || `api://${CLIENT_ID}/access_as_user`,
  ],
};
