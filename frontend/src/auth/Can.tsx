/**
 * <Can> — conditionally render children when the caller holds a permission.
 *
 *   <Can permission="findings:write" collectionId={machine.collectionId}>
 *     <EditButton />
 *   </Can>
 *
 * Optionally render a `fallback` (e.g. a disabled/explanatory element) when the
 * permission is absent.
 */
import { ReactNode } from 'react';
import { usePermissions } from './AuthzProvider';
import type { Permission } from './permissions';

export function Can({
  permission,
  collectionId,
  fallback = null,
  children,
}: {
  permission: Permission;
  collectionId?: string;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { has } = usePermissions();
  return <>{has(permission, collectionId) ? children : fallback}</>;
}
