import { describe, expect, it } from 'vitest';
import { parseResponse } from '../src/portacount';

describe('parseResponse', () => {
  it('parses SYSTEM/ALL into a structured object', () => {
    const r = parseResponse(
      '<MAIN><SYSTEM>' +
      '<SERIAL_NUMBER>00023550</SERIAL_NUMBER>' +
      '<MODEL_NUMBER>8030</MODEL_NUMBER>' +
      '<BUILD_STRING>3.0.0</BUILD_STRING>' +
      '</SYSTEM></MAIN>',
    );
    expect(r.MAIN?.SYSTEM?.SERIAL_NUMBER).toBe('00023550');
    expect(r.MAIN?.SYSTEM?.MODEL_NUMBER).toBe('8030');
    expect(r.MAIN?.SYSTEM?.BUILD_STRING).toBe('3.0.0');
  });

  it('ignores attributes on LOCK COMMAND="READ"', () => {
    const r = parseResponse('<MAIN><SYSTEM><LOCK COMMAND="READ">REMOTE</LOCK></SYSTEM></MAIN>');
    expect(r.MAIN?.SYSTEM?.LOCK).toBe('REMOTE');
  });

  it('tolerates a trailing \\r\\r terminator', () => {
    const r = parseResponse('<MAIN><SYSTEM><LOCK>UNLOCK</LOCK></SYSTEM></MAIN>\r\r');
    expect(r.MAIN?.SYSTEM?.LOCK).toBe('UNLOCK');
  });

  it('parses a self-closing tag as an empty string', () => {
    const r = parseResponse('<MAIN/>');
    expect(r.MAIN).toBe('');
  });

  it('parses REALTIME/ALL with all sibling tags', () => {
    const r = parseResponse(
      '<MAIN><REALTIME>' +
      '<AMB_CONC>2500</AMB_CONC>' +
      '<MASK_CONC>25</MASK_CONC>' +
      '<FITFACTOR>100</FITFACTOR>' +
      '<MESSAGE>OK</MESSAGE>' +
      '<STATUS>READY</STATUS>' +
      '<N95_ENABLE>0</N95_ENABLE>' +
      '<COUNT_MODE>N99</COUNT_MODE>' +
      '</REALTIME></MAIN>',
    );
    expect(r.MAIN?.REALTIME?.AMB_CONC).toBe('2500');
    expect(r.MAIN?.REALTIME?.MASK_CONC).toBe('25');
    expect(r.MAIN?.REALTIME?.FITFACTOR).toBe('100');
    expect(r.MAIN?.REALTIME?.STATUS).toBe('READY');
    expect(r.MAIN?.REALTIME?.COUNT_MODE).toBe('N99');
  });

  it('keeps leading zeros and numeric-looking text as strings', () => {
    // parseTagValue:false means the parser doesn't try to coerce.
    const r = parseResponse('<MAIN><SYSTEM><SERIAL_NUMBER>00023550</SERIAL_NUMBER></SYSTEM></MAIN>');
    expect(r.MAIN?.SYSTEM?.SERIAL_NUMBER).toBe('00023550');
    expect(typeof r.MAIN?.SYSTEM?.SERIAL_NUMBER).toBe('string');
  });

  it('returns undefined for tags that are not present', () => {
    const r = parseResponse('<MAIN><SYSTEM></SYSTEM></MAIN>');
    expect(r.MAIN?.SYSTEM?.SERIAL_NUMBER).toBeUndefined();
  });

  it('exposes an ERROR child of MAIN', () => {
    const r = parseResponse('<MAIN><ERROR>unknown command</ERROR></MAIN>');
    expect(r.MAIN?.ERROR).toBe('unknown command');
  });
});
