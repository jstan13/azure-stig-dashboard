import { strToU8, zipSync } from 'fflate';
import { extractXccdfArchive } from '../stigs/xccdfDownloader';

describe('XCCDF ZIP extraction', () => {
  it('prefers manual XCCDF content and ignores non-XML entries', () => {
    const archive = zipSync({
      'README.txt': strToU8('not benchmark content'),
      'SCAP/automated-xccdf.xml': strToU8('<Benchmark id="automated" />'),
      'Manual/manual-xccdf.xml': strToU8('<Benchmark id="manual" />'),
    });

    expect(extractXccdfArchive(archive)).toBe('<Benchmark id="manual" />');
  });

  it('rejects archives without XML benchmark content', () => {
    const archive = zipSync({ 'README.txt': strToU8('not benchmark content') });

    expect(() => extractXccdfArchive(archive)).toThrow('No XCCDF file found in ZIP');
  });
});