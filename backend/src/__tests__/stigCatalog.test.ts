import { normaliseVersionString, parseCatalogResponse } from '../stigs/stigCatalog';

describe('Cyber.mil STIG catalog', () => {
  it('maps manual STIG ZIP records and excludes automation content', () => {
    const entries = parseCatalogResponse({
      returnValue: [
        {
          FileName: 'Microsoft Windows 11 STIG - Ver 2, Rel 9',
          UploadDate: '2026-08-17',
          DownloadLink: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_MS_Windows_11_V2R9_STIG.zip',
          RawDownloadType: 'Operating Systems;STIGs;Windows',
        },
        {
          FileName: 'Microsoft Windows 11 STIG SCAP Benchmark - Ver 2, Rel 10',
          UploadDate: '2026-08-17',
          DownloadLink: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_MS_Windows_11_V2R10_STIG_SCAP.zip',
          RawDownloadType: 'STIGs;SCAP 1.3;Automation',
        },
        {
          FileName: 'Microsoft Windows 11 STIG - Ver 2, Rel 8',
          UploadDate: '2026-05-10',
          DownloadLink: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_MS_Windows_11_V2R8_STIG.zip',
          RawDownloadType: 'Operating Systems;STIGs;Windows',
        },
        {
          FileName: 'Sunset - Microsoft Windows 10 STIG - Ver 2, Rel 9',
          UploadDate: '2024-05-02',
          DownloadLink: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_MS_Windows_10_V2R9_STIG.zip',
          RawDownloadType: 'STIGs;Sunset;Windows',
        },
      ],
    });

    expect(entries).toEqual([{
      title: 'Microsoft Windows 11 STIG - Ver 2, Rel 9',
      version: 'V2R9',
      releaseDate: '2026-08-17',
      downloadUrl: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_MS_Windows_11_V2R9_STIG.zip',
      filename: 'U_MS_Windows_11_V2R9_STIG.zip',
      type: 'STIG',
    }]);
  });

  it('rejects an unexpected response instead of silently returning an empty catalog', () => {
    expect(() => parseCatalogResponse('<html>sign in</html>')).toThrow();
  });

  it('normalizes abbreviated Cyber.mil version labels', () => {
    expect(normaliseVersionString('Windows STIG - Ver 3, Rel 2')).toBe('V3R2');
    expect(normaliseVersionString('Microsoft IIS STIG U_MS_IIS_V3R4_STIG.zip')).toBe('V3R4');
  });
});