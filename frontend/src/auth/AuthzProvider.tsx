/**
 * AuthzProvider — fetches the caller's effective access from `GET /api/me`
 * and exposes it through React context so any component can gate UI on
 * permissions instead of guessing from role names.
 *
 * The backend remains the source of truth; this only drives what the UI shows.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useApi } from '../hooks/useApi';
import type { Permission, Role } from './permissions';

export interface CollectionAccess {
  id: string;
  name: string;
  roles: Role[];
  permissions: Permission[];
}

export interface MeResponse {
  oid: string;
  subject: string;
  upn: string | null;
  name: string | null;
  groupsOverage: boolean;
  globalRoles: Role[];
  permissions: Permission[];
  collections: CollectionAccess[];
}

export interface AuthzContextValue {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch /api/me (call after a role/collection change). */
  refresh: () => Promise<void>;
  /**
   * True when the caller holds `permission`. When `collectionId` is given the
   * check is scoped to that boundary (or any global grant); otherwise a global
   * OR any-collection grant satisfies it (the server still enforces per-scope).
   */
  has: (permission: Permission, collectionId?: string) => boolean;
  /** True when the caller holds `role` globally. */
  hasGlobalRole: (role: Role) => boolean;
}

const AuthzContext = createContext<AuthzContextValue | undefined>(undefined);

export function AuthzProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<MeResponse>('/api/me');
      setMe(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load permissions');
      setMe(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const has = useCallback(
    (permission: Permission, collectionId?: string): boolean => {
      if (!me) return false;
      if (me.permissions.includes(permission)) return true;
      if (collectionId) {
        const c = me.collections.find((x) => x.id === collectionId);
        return !!c && c.permissions.includes(permission);
      }
      return me.collections.some((c) => c.permissions.includes(permission));
    },
    [me],
  );

  const hasGlobalRole = useCallback(
    (role: Role): boolean => !!me && me.globalRoles.includes(role),
    [me],
  );

  const value = useMemo<AuthzContextValue>(
    () => ({ me, loading, error, refresh, has, hasGlobalRole }),
    [me, loading, error, refresh, has, hasGlobalRole],
  );

  return <AuthzContext.Provider value={value}>{children}</AuthzContext.Provider>;
}

/** Access the authorization context. Throws if used outside <AuthzProvider>. */
export function usePermissions(): AuthzContextValue {
  const ctx = useContext(AuthzContext);
  if (!ctx) throw new Error('usePermissions must be used within <AuthzProvider>');
  return ctx;
}
