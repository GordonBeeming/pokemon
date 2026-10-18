import { describe, expect, it } from 'vitest';
import { ebaySoldSearchUrl } from './ebay';

describe('ebaySoldSearchUrl', () => {
  it('searches eBay Australia sold listings for the raw card', () => {
    const url = new URL(
      ebaySoldSearchUrl({ name: 'Claydol', number: '58', setName: 'Battle Styles' }),
    );
    expect(url.origin).toBe('https://www.ebay.com.au');
    expect(url.pathname).toBe('/sch/i.html');
    expect(url.searchParams.get('_nkw')).toBe('Claydol 58 Battle Styles -psa -cgc -bgs');
    expect(url.searchParams.get('LH_Sold')).toBe('1');
    expect(url.searchParams.get('LH_Complete')).toBe('1');
  });

  it('encodes names with accents and symbols', () => {
    const url = ebaySoldSearchUrl({ name: 'Flabébé', number: '82/162', setName: 'Kalos & Co' });
    expect(url).toContain('Flab%C3%A9b%C3%A9');
    expect(new URL(url).searchParams.get('_nkw')).toBe('Flabébé 82/162 Kalos & Co -psa -cgc -bgs');
  });
});
