/**
 * DISA GPO package discovery, parsing, and comparison.
 *
 * The quarterly package is a ZIP of product folders, each holding Backup-GPO
 * output under `GPOs/{BackupId}/` with a `bkupInfo.xml` (display name) and a
 * UTF-16 `gpreport.xml` (every configured setting). Settings are flattened to
 * stable `key → canonical value` pairs so two releases — or a DISA backup and
 * the GPO an agent actually created — can be compared setting by setting.
 */

import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { RawCatalogItem } from '../stigs/stigCatalog';

const MAX_XML_BYTES = 20 * 1024 * 1024;
const BACKUP_FILE_RE = /^(.*?)\/GPOs\/(\{[0-9A-Fa-f-]{36}\})\/(bkupInfo|gpreport)\.xml$/;

export interface GpoCatalogEntry {
  packageName: string;
  label: string;
  releaseDate: string;
  downloadUrl: string;
}

export interface PackageGpo {
  backupId: string;
  displayName: string;
  /** Display name with the trailing DISA version removed, e.g. "DoD WinSvr 2022 MS STIG Comp". */
  family: string;
  /** Top-level product folder inside the package. */
  folder: string;
  /** Archive directory passed to Import-GPO -Path, e.g. "DoD Windows 11 v2r8/GPOs". */
  backupDirectory: string;
  settingCount: number;
}

export type GpoSettings = Record<string, string>;

export interface ParsedGpoPackage {
  gpos: PackageGpo[];
  /** backupId → flattened settings. */
  settings: Record<string, GpoSettings>;
}

export interface GpoSettingDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface GpoFamilyChange extends GpoSettingDiff {
  family: string;
  fromName: string;
  toName: string;
}

export interface GpoPackageDiff {
  previousReleaseId: string | null;
  previousLabel: string | null;
  addedGpos: string[];
  removedGpos: string[];
  changedGpos: GpoFamilyChange[];
  unchangedGpos: string[];
}

/**
 * Picks the newest DISA STIG GPO package. Intune and other policy packages are
 * published under the same download type, so the file name is matched too.
 */
export function selectLatestGpoPackage(items: RawCatalogItem[]): GpoCatalogEntry | null {
  const packages = items
    .filter((item) => /Group Policy Objects/i.test(item.RawDownloadType)
      && /^Group Policy Objects\b/i.test(item.FileName.trim())
      && item.DownloadLink.toLowerCase().endsWith('.zip'))
    .sort((a, b) => b.UploadDate.localeCompare(a.UploadDate));
  const latest = packages[0];
  if (!latest) return null;
  const name = latest.FileName.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const label = name.split(/\s+[-\u2013\u2014]\s+/).pop()?.trim() || latest.UploadDate;
  return {
    packageName: name,
    label,
    releaseDate: latest.UploadDate,
    downloadUrl: latest.DownloadLink,
  };
}

export function gpoFamily(displayName: string): string {
  return displayName.replace(/\s+v\d+\s*r\d+\s*$/i, '').trim();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  isArray: (_name, _jpath, _isLeaf, isAttribute) => !isAttribute,
});

/** gpreport.xml is UTF-16LE with a BOM; bkupInfo.xml is usually UTF-8. */
export function decodeXml(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

type XmlNode = Record<string, unknown>;

function first(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as XmlNode)[key];
  return Array.isArray(value) ? value[0] : value;
}

function text(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    const t = (node as XmlNode)['#text'];
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.join('');
  }
  return undefined;
}

function childText(node: unknown, ...path: string[]): string | undefined {
  let current = node;
  for (const key of path) current = first(current, key);
  return text(current);
}

/** Descriptive-only fields that vary with the reporting machine's ADMX files. */
const IGNORED_FIELDS = new Set(['Explain', 'Supported', 'Category', 'Display']);

function canonical(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(canonical);
    return parts.length === 1 ? parts[0] : `[${parts.sort().join(',')}]`;
  }
  const entries = Object.entries(value as XmlNode)
    .filter(([key]) => !IGNORED_FIELDS.has(key) && !key.startsWith('@_xmlns'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${key}=${canonical(v)}`);
  return `{${entries.join(';')}}`;
}

function settingIdentity(tag: string, item: unknown): string {
  switch (tag) {
    case 'Policy':
      return `${childText(item, 'Category') ?? ''}/${childText(item, 'Name') ?? ''}`;
    case 'SecurityOptions':
      return childText(item, 'KeyName')
        ?? childText(item, 'SystemAccessPolicyName')
        ?? childText(item, 'Display', 'Name')
        ?? '';
    case 'Account':
      return `${childText(item, 'Type') ?? ''}/${childText(item, 'Name') ?? ''}`;
    case 'AuditSetting':
      return childText(item, 'SubcategoryName') ?? childText(item, 'SubcategoryGuid') ?? '';
    case 'RegistrySetting':
      return `${childText(item, 'KeyPath') ?? ''}\\${childText(item, 'Value', 'Name') ?? ''}`;
    case 'EventLog':
      return `${childText(item, 'Log') ?? ''}/${childText(item, 'Name') ?? ''}`;
    default: {
      const name = childText(item, 'Name') ?? childText(item, 'KeyName') ?? childText(item, 'KeyPath');
      if (name) return name;
      const attr = item && typeof item === 'object' ? (item as XmlNode)['@_name'] : undefined;
      return typeof attr === 'string' ? attr : '';
    }
  }
}

/**
 * Flattens a gpreport.xml into setting keys of the form
 * `<Computer|User>|<extension>|<element>|<identity>`.
 */
export function flattenGpoReport(xml: string): GpoSettings {
  const doc = parser.parse(xml) as XmlNode;
  const gpo = first(doc, 'GPO');
  if (!gpo) throw new Error('Not a Group Policy report: missing <GPO> root');
  const settings: GpoSettings = {};

  for (const scope of ['Computer', 'User']) {
    const scopeNode = first(gpo, scope);
    const extensionData = (scopeNode as XmlNode | undefined)?.ExtensionData;
    if (!Array.isArray(extensionData)) continue;
    for (const ed of extensionData) {
      const extName = childText(ed, 'Name') ?? 'Unknown';
      const extension = first(ed, 'Extension') as XmlNode | undefined;
      if (!extension || typeof extension !== 'object') continue;
      for (const [tag, items] of Object.entries(extension)) {
        if (tag.startsWith('@_') || tag === '#text' || tag === 'Blocked') continue;
        for (const item of Array.isArray(items) ? items : [items]) {
          const base = `${scope}|${extName}|${tag}|${settingIdentity(tag, item)}`;
          let key = base;
          for (let n = 2; key in settings; n++) key = `${base}#${n}`;
          settings[key] = canonical(item);
        }
      }
    }
  }
  return settings;
}

export function diffSettings(before: GpoSettings, after: GpoSettings): GpoSettingDiff {
  const added = Object.keys(after).filter((k) => !(k in before)).sort();
  const removed = Object.keys(before).filter((k) => !(k in after)).sort();
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]).sort();
  return { added, removed, changed };
}

export function parseGpoPackage(zip: Uint8Array): ParsedGpoPackage {
  const oversized: string[] = [];
  const files = unzipSync(zip, {
    filter: (entry) => {
      if (!BACKUP_FILE_RE.test(entry.name)) return false;
      if (entry.originalSize > MAX_XML_BYTES) {
        oversized.push(entry.name);
        return false;
      }
      return true;
    },
  });
  if (oversized.length) {
    throw new Error(`GPO package entries exceed the extraction limit: ${oversized.join(', ')}`);
  }

  const backups = new Map<string, { folder: string; directory: string; info?: string; report?: string }>();
  for (const [name, bytes] of Object.entries(files)) {
    const m = BACKUP_FILE_RE.exec(name);
    if (!m) continue;
    const [, folderPath, backupId, kind] = m;
    const key = `${folderPath}/${backupId}`;
    const entry = backups.get(key) ?? { folder: folderPath.split('/')[0], directory: `${folderPath}/GPOs` };
    if (kind === 'bkupInfo') entry.info = decodeXml(bytes);
    else entry.report = decodeXml(bytes);
    backups.set(key, entry);
  }

  const gpos: PackageGpo[] = [];
  const settings: Record<string, GpoSettings> = {};
  for (const [key, entry] of backups) {
    const backupId = key.slice(key.lastIndexOf('/') + 1).toUpperCase();
    if (!entry.info || !entry.report) {
      throw new Error(`GPO backup ${key} is missing bkupInfo.xml or gpreport.xml`);
    }
    const info = parser.parse(entry.info) as XmlNode;
    const displayName = childText(first(info, 'BackupInst'), 'GPODisplayName')?.trim();
    if (!displayName) throw new Error(`GPO backup ${key} has no display name`);
    if (settings[backupId]) throw new Error(`GPO backup ID ${backupId} appears more than once`);
    const flattened = flattenGpoReport(entry.report);
    settings[backupId] = flattened;
    gpos.push({
      backupId,
      displayName,
      family: gpoFamily(displayName),
      folder: entry.folder,
      backupDirectory: entry.directory,
      settingCount: Object.keys(flattened).length,
    });
  }

  if (gpos.length === 0) throw new Error('The archive contains no Group Policy backups');
  gpos.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { gpos, settings };
}

export function settingsFingerprint(settings: GpoSettings): string {
  const ordered = Object.keys(settings).sort().map((k) => `${k}\u0000${settings[k]}`).join('\u0001');
  return crypto.createHash('sha256').update(ordered).digest('hex');
}

/** Compares two packages GPO-by-GPO, pairing GPOs by family across versions. */
export function diffPackages(
  previous: { id: string; label: string; parsed: ParsedGpoPackage } | null,
  current: ParsedGpoPackage,
): GpoPackageDiff {
  const result: GpoPackageDiff = {
    previousReleaseId: previous?.id ?? null,
    previousLabel: previous?.label ?? null,
    addedGpos: [],
    removedGpos: [],
    changedGpos: [],
    unchangedGpos: [],
  };
  const prevByFamily = new Map((previous?.parsed.gpos ?? []).map((g) => [g.family, g]));
  const currentFamilies = new Set(current.gpos.map((g) => g.family));

  for (const gpo of current.gpos) {
    const old = prevByFamily.get(gpo.family);
    if (!old || !previous) {
      result.addedGpos.push(gpo.displayName);
      continue;
    }
    const diff = diffSettings(
      previous.parsed.settings[old.backupId] ?? {},
      current.settings[gpo.backupId] ?? {},
    );
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      result.changedGpos.push({ family: gpo.family, fromName: old.displayName, toName: gpo.displayName, ...diff });
    } else {
      result.unchangedGpos.push(gpo.displayName);
    }
  }
  for (const old of previous?.parsed.gpos ?? []) {
    if (!currentFamilies.has(old.family)) result.removedGpos.push(old.displayName);
  }
  return result;
}
