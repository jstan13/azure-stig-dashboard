/**
 * Regression tests for CSV-injection neutralisation (OWASP CSV Injection).
 *
 * Background: When user-supplied finding text begins with =, +, -, @, tab, or
 * CR, Excel / LibreOffice will treat the cell as a formula, enabling DDE-based
 * code execution. We must prefix such cells with a single quote (inside the
 * double-quoted CSV field) to neutralise the formula trigger.
 */
import { csvSafe } from '../routes/export';

describe('csvSafe — CSV injection neutralisation', () => {
  it('quotes a plain string', () => {
    expect(csvSafe('hello')).toBe('"hello"');
  });

  it('neutralises a leading "=" formula', () => {
    // =1+1 would otherwise evaluate to 2 in Excel
    expect(csvSafe('=1+1')).toBe(`"'=1+1"`);
  });

  it('neutralises a leading "+" formula', () => {
    expect(csvSafe('+CMD|"calc"!A1')).toBe(`"'+CMD|""calc""!A1"`);
  });

  it('neutralises a leading "-" formula', () => {
    expect(csvSafe('-2+3')).toBe(`"'-2+3"`);
  });

  it('neutralises a leading "@" (Lotus / DDE)', () => {
    expect(csvSafe('@SUM(1,1)')).toBe(`"'@SUM(1,1)"`);
  });

  it('neutralises a leading tab character', () => {
    expect(csvSafe('\t=1+1')).toBe(`"'\t=1+1"`);
  });

  it('neutralises a leading carriage return', () => {
    expect(csvSafe('\r=1+1')).toBe(`"'\r=1+1"`);
  });

  it('escapes embedded double quotes', () => {
    expect(csvSafe('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('escapes embedded double quotes AND neutralises formula', () => {
    expect(csvSafe('="evil"')).toBe(`"'=""evil"""`);
  });

  it('handles null / undefined safely', () => {
    expect(csvSafe(null)).toBe('""');
    expect(csvSafe(undefined)).toBe('""');
  });

  it('does NOT neutralise safe leading characters', () => {
    // Numbers, letters, and most punctuation are safe
    expect(csvSafe('123')).toBe('"123"');
    expect(csvSafe('V-12345')).toBe('"V-12345"'); // V- is safe; only leading - triggers
    expect(csvSafe('CAT II')).toBe('"CAT II"');
  });
});
