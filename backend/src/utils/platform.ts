import { MachineEntity } from '../models/Machine';

/**
 * Platform derivation for platform-wide manual answers.
 *
 * A STIG manual answer scoped to a "platform" applies to every machine on that
 * platform. We derive the platform from what the dashboard already knows about
 * a machine — no extra data entry required:
 *
 *   - Native Azure VM (not Arc-connected)            -> 'azure'
 *   - Azure Arc-connected server                     -> 'arc' (or 'arc-<cloud>'
 *       when a cloud hint is present in tags)
 *
 * Arc-enabled servers can run anywhere (on-prem, AWS, GCP) yet are managed
 * through Azure (including Guest Configuration), so they form their own
 * platform bucket. If a tag identifies the underlying cloud we refine the key
 * (e.g. 'arc-aws') so answers can be targeted per environment.
 */

const CLOUD_TAG_KEYS = ['platform', 'cloud', 'environmentPlatform', 'hostCloud'];
const KNOWN_CLOUDS = new Set(['aws', 'gcp', 'azure', 'onprem', 'on-prem', 'vmware']);

export type PlatformInfo = { key: string; label: string };

/** Stable platform key for a machine (used as ManualAnswer.scopeId). */
export function platformOf(machine: Pick<MachineEntity, 'isArcConnected' | 'tags'>): string {
  if (!machine.isArcConnected) return 'azure';

  const tags = machine.tags ?? {};
  for (const [k, v] of Object.entries(tags)) {
    if (CLOUD_TAG_KEYS.includes(k.toLowerCase()) && typeof v === 'string') {
      const cloud = v.toLowerCase().replace('on-prem', 'onprem');
      if (KNOWN_CLOUDS.has(v.toLowerCase()) || KNOWN_CLOUDS.has(cloud)) {
        return cloud === 'azure' ? 'arc-azure' : `arc-${cloud}`;
      }
    }
  }
  return 'arc';
}

/** Human-friendly label for a platform key. */
export function platformLabel(key: string): string {
  switch (key) {
    case 'azure': return 'Azure (native VM)';
    case 'arc':   return 'Azure Arc';
    default:
      if (key.startsWith('arc-')) {
        const cloud = key.slice(4);
        return `Azure Arc — ${cloud.toUpperCase()}`;
      }
      return key;
  }
}

export function platformInfoOf(machine: Pick<MachineEntity, 'isArcConnected' | 'tags'>): PlatformInfo {
  const key = platformOf(machine);
  return { key, label: platformLabel(key) };
}
