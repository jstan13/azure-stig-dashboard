import { strToU8, zipSync } from 'fflate';
import {
  decodeXml, diffPackages, flattenGpoReport, gpoFamily, parseGpoPackage, selectLatestGpoPackage,
} from '../gpo/gpoPackage';

const report = (policies: Array<[string, string]>, lockout = 3) => `<?xml version="1.0" encoding="utf-16"?>
<GPO xmlns="http://www.microsoft.com/GroupPolicy/Settings">
  <Name>Example</Name>
  <Computer>
    <Enabled>true</Enabled>
    <ExtensionData>
      <Extension xmlns:q1="http://www.microsoft.com/GroupPolicy/Settings/Security" xsi:type="q1:SecuritySettings" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <q1:Account><q1:Name>LockoutBadCount</q1:Name><q1:SettingNumber>${lockout}</q1:SettingNumber><q1:Type>Account Lockout</q1:Type></q1:Account>
        <q1:Blocked>false</q1:Blocked>
      </Extension>
      <Name>Security</Name>
    </ExtensionData>
    <ExtensionData>
      <Extension xmlns:q3="http://www.microsoft.com/GroupPolicy/Settings/Registry" xsi:type="q3:RegistrySettings" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${policies.map(([name, state]) => `<q3:Policy><q3:Name>${name}</q3:Name><q3:State>${state}</q3:State><q3:Explain>Varies by ADMX</q3:Explain><q3:Category>Windows Components/Example</q3:Category></q3:Policy>`).join('')}
      </Extension>
      <Name>Registry</Name>
    </ExtensionData>
  </Computer>
  <User><Enabled>false</Enabled></User>
</GPO>`;

function utf16(xml: string): Uint8Array {
  return Uint8Array.from([0xff, 0xfe, ...Buffer.from(xml, 'utf16le')]);
}

function backupInfo(name: string): Uint8Array {
  return strToU8(`<BackupInst xmlns="http://www.microsoft.com/GroupPolicy/GPOOperations/Manifest"><ID><![CDATA[{X}]]></ID><GPODisplayName><![CDATA[${name}]]></GPODisplayName></BackupInst>`);
}

function packageZip(gpos: Array<{ id: string; name: string; xml: string }>): Uint8Array {
  const files: Record<string, Uint8Array> = { 'ReadMe.txt': strToU8('readme') };
  for (const g of gpos) {
    files[`DoD Example v1r2/GPOs/${g.id}/bkupInfo.xml`] = backupInfo(g.name);
    files[`DoD Example v1r2/GPOs/${g.id}/gpreport.xml`] = utf16(g.xml);
  }
  return zipSync(files);
}

describe('DISA GPO package catalog', () => {
  it('selects the newest STIG GPO package and ignores Intune packages', () => {
    const entry = selectLatestGpoPackage([
      { FileName: 'Group Policy Objects (GPOs) - April 2026', UploadDate: '2026-04-20', DownloadLink: 'https://dl.dod.cyber.mil/x/U_STIG_GPO_Package_April_2026.zip', RawDownloadType: 'STIGs;Group Policy Objects (GPO)' },
      { FileName: 'Intune Policy - October 2026', UploadDate: '2026-10-02', DownloadLink: 'https://dl.dod.cyber.mil/x/U_Intune_Policy_Package_October_2026.zip', RawDownloadType: 'STIGs;Group Policy Objects (GPO)' },
      { FileName: 'Group Policy Objects (GPOs) - July 2026', UploadDate: '2026-08-17', DownloadLink: 'https://dl.dod.cyber.mil/x/U_STIG_GPO_Package_July_2026.zip', RawDownloadType: 'STIGs;Group Policy Objects (GPO)' },
      { FileName: 'Windows 11 STIG', UploadDate: '2026-09-01', DownloadLink: 'https://dl.dod.cyber.mil/x/U_MS_Windows_11.zip', RawDownloadType: 'STIGs;Windows' },
    ]);
    expect(entry).toEqual({
      packageName: 'Group Policy Objects (GPOs) - July 2026',
      label: 'July 2026',
      releaseDate: '2026-08-17',
      downloadUrl: 'https://dl.dod.cyber.mil/x/U_STIG_GPO_Package_July_2026.zip',
    });
  });

  it('pairs GPOs across releases by removing only the trailing version', () => {
    expect(gpoFamily('DoD WinSvr 2022 MS STIG Comp v2r9')).toBe('DoD WinSvr 2022 MS STIG Comp');
    expect(gpoFamily('DoD Adobe Acrobat Pro DC Continuous STIG Computer V2R1')).toBe('DoD Adobe Acrobat Pro DC Continuous STIG Computer');
    expect(gpoFamily('Local Policy DoD Windows 11 User STIG v2r8')).toBe('Local Policy DoD Windows 11 User STIG');
  });
});

describe('GPO report flattening', () => {
  it('decodes UTF-16 reports and ignores ADMX-dependent descriptive text', () => {
    const xml = report([['Block downloads', 'Enabled']]);
    const settings = flattenGpoReport(decodeXml(utf16(xml)));
    expect(settings).toEqual({
      'Computer|Security|Account|Account Lockout/LockoutBadCount': '{Name=LockoutBadCount;SettingNumber=3;Type=Account Lockout}',
      'Computer|Registry|Policy|Windows Components/Example/Block downloads': '{Name=Block downloads;State=Enabled}',
    });
    const reworded = xml.replace('Varies by ADMX', 'Different help text');
    expect(flattenGpoReport(reworded)).toEqual(settings);
  });

  it('rejects documents that are not GPO reports', () => {
    expect(() => flattenGpoReport('<html><body>sign in</body></html>')).toThrow(/missing <GPO>/);
  });
});

describe('GPO package parsing and diff', () => {
  const idA = '{A9FE9CE6-FD03-4832-9321-5B87A861D5B6}';
  const idB = '{CD80AEFB-15EA-4AD5-86D8-45A4E428636E}';

  it('reads every backup with its import directory and setting count', () => {
    const parsed = parseGpoPackage(packageZip([
      { id: idA, name: 'DoD Example STIG Comp v1r2', xml: report([['One', 'Enabled'], ['Two', 'Disabled']]) },
    ]));
    expect(parsed.gpos).toEqual([{
      backupId: idA,
      displayName: 'DoD Example STIG Comp v1r2',
      family: 'DoD Example STIG Comp',
      folder: 'DoD Example v1r2',
      backupDirectory: 'DoD Example v1r2/GPOs',
      settingCount: 3,
    }]);
  });

  it('reports setting-level changes, new GPOs, and removed GPOs between releases', () => {
    const previous = parseGpoPackage(packageZip([
      { id: idA, name: 'DoD Example STIG Comp v1r1', xml: report([['One', 'Enabled'], ['Gone', 'Enabled']]) },
      { id: idB, name: 'DoD Retired STIG v1r1', xml: report([]) },
    ]));
    const current = parseGpoPackage(packageZip([
      { id: idA, name: 'DoD Example STIG Comp v1r2', xml: report([['One', 'Disabled'], ['New', 'Enabled']], 5) },
      { id: idB, name: 'DoD Brand New STIG v1r1', xml: report([]) },
    ]));
    const diff = diffPackages({ id: 'prev', label: 'April 2026', parsed: previous }, current);
    expect(diff.addedGpos).toEqual(['DoD Brand New STIG v1r1']);
    expect(diff.removedGpos).toEqual(['DoD Retired STIG v1r1']);
    expect(diff.changedGpos).toEqual([{
      family: 'DoD Example STIG Comp',
      fromName: 'DoD Example STIG Comp v1r1',
      toName: 'DoD Example STIG Comp v1r2',
      added: ['Computer|Registry|Policy|Windows Components/Example/New'],
      removed: ['Computer|Registry|Policy|Windows Components/Example/Gone'],
      changed: [
        'Computer|Registry|Policy|Windows Components/Example/One',
        'Computer|Security|Account|Account Lockout/LockoutBadCount',
      ],
    }]);
  });

  it('refuses archives without Group Policy backups', () => {
    expect(() => parseGpoPackage(zipSync({ 'ReadMe.txt': strToU8('x') }))).toThrow(/no Group Policy backups/);
  });
});
