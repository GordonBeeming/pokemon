/**
 * eBay Australia's sold-listings search for one card: its name, number and set, with
 * sold and completed listings only. Graded slabs sell for far more than the raw copies
 * the collection tracks, so the common graders are left out of the search.
 */
export function ebaySoldSearchUrl(card: { name: string; number: string; setName: string }): string {
  const url = new URL('https://www.ebay.com.au/sch/i.html');
  url.searchParams.set('_nkw', `${card.name} ${card.number} ${card.setName} -psa -cgc -bgs`);
  url.searchParams.set('LH_Sold', '1');
  url.searchParams.set('LH_Complete', '1');
  return url.toString();
}
