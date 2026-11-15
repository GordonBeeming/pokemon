interface EbaySearchCard {
  name: string;
  number: string;
  setName: string;
}

/** Shared search for raw copies: graded slabs sell for far more than the cards
 * the collection tracks, so the common graders are excluded from both searches. */
function ebaySearchUrl(card: EbaySearchCard): URL {
  const url = new URL('https://www.ebay.com.au/sch/i.html');
  url.searchParams.set('_nkw', `${card.name} ${card.number} ${card.setName} -psa -cgc -bgs`);
  // The Australian domain also includes overseas listings without this filter.
  url.searchParams.set('LH_PrefLoc', '1');
  return url;
}

export function ebayBuySearchUrl(card: EbaySearchCard): string {
  return ebaySearchUrl(card).toString();
}

export function ebaySoldSearchUrl(card: EbaySearchCard): string {
  const url = ebaySearchUrl(card);
  url.searchParams.set('LH_Sold', '1');
  url.searchParams.set('LH_Complete', '1');
  return url.toString();
}
