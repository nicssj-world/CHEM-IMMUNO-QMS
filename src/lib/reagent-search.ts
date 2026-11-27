export type SearchableReagent = { id: string; product_code: string; display_name: string };

/** Case-insensitive contains-search, including mid-code digits and compact codes
 * (CHE0001 also finds CHE-0001). Works with Thai names and multiple query words.
 */
function normalized(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

export function searchReagents<T extends SearchableReagent>(
  products: readonly T[], query: string,
): T[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return products.filter(product => {
    const display = normalized(`${product.product_code} ${product.display_name}`);
    const compact = display.replace(/[\s\-_/]+/g, '');
    return terms.every(term => display.includes(term) || compact.includes(term.replace(/[\s\-_/]+/g, '')));
  }).sort((a,b) => {
    // Code prefixes first, then word/name prefixes, then other substring matches.
    const rank = (product: T) => {
      const code = normalized(product.product_code);
      const name = normalized(product.display_name);
      const first = terms[0];
      return code.startsWith(first) ? 0 : name.startsWith(first) ? 1 : code.includes(first) ? 2 : 3;
    };
    return rank(a) - rank(b) || a.product_code.localeCompare(b.product_code, undefined, {numeric:true});
  });
}
