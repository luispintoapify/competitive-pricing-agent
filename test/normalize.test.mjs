// Tests the normalize step of the shipped workflow.
//
// It reads the code out of workflow.n8n.json rather than keeping a copy, so the
// test always exercises the artifact people actually import. A copy would drift,
// and a drifting test is worse than none.
//
//   npm test
//
// No dependencies, no build step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = JSON.parse(readFileSync(new URL('../workflow.n8n.json', import.meta.url), 'utf8'));
const node = workflow.nodes.find((n) => n.name === 'Normalize products');
assert.ok(node, 'the workflow must contain a "Normalize products" node');

// Take the helper definitions and drop the part that needs n8n's $input.
const source = node.parameters.jsCode;
const cut = source.indexOf('const rows = [];');
assert.ok(cut > 0, 'the normalize node must define its helpers before building rows');

const { parsePrice, readBrand, readCurrency, readStock, canonicalUrl } = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      source.slice(0, cut) +
        '\nexport { parsePrice, readBrand, readCurrency, readStock, canonicalUrl };'
    )
);

test('parsePrice handles US formatting', () => {
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice('$12.99'), 12.99);       // Walmart returns a string
  assert.equal(parsePrice('US $265.65'), 265.65);  // eBay priceText
  assert.equal(parsePrice(39.09), 39.09);          // Amazon returns a number
});

test('parsePrice handles European formatting', () => {
  // Stripping everything but digits and dots turned these into 1.29999, 129999
  // and 1299 respectively: plausible numbers, all wrong.
  assert.equal(parsePrice('1.299,99 €'), 1299.99);
  assert.equal(parsePrice('€1 299,99'), 1299.99);
  assert.equal(parsePrice('12,99 €'), 12.99);
  assert.equal(parsePrice('1 299,00 zł'), 1299);
});

test('parsePrice treats a lone separator with three digits as thousands', () => {
  assert.equal(parsePrice('1,299'), 1299);
  assert.equal(parsePrice('1.299'), 1299);
});

test('parsePrice rejects what is not a price', () => {
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(0), null);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice('out of stock'), null);
});

test('readBrand never returns [object Object]', () => {
  // Each of these reached the database as the literal string "[object Object]".
  assert.equal(readBrand({ brand: { name: null } }), null);
  assert.equal(readBrand({ brand: {} }), null);
  assert.equal(readBrand({ brand: { name: null, slogan: null } }), null);
});

test('readBrand unwraps marketing copy and rejects sentences', () => {
  assert.equal(readBrand({ brand: { slogan: 'Visit the Carhartt Store' } }), 'Carhartt');
  assert.equal(readBrand({ brand: { slogan: 'QINSEN' } }), 'QINSEN');
  assert.equal(readBrand({ brand: 'Hanes' }), 'Hanes');
  assert.equal(readBrand({ brand: 'a b c d e f' }), null);
});

test('readCurrency stores ISO 4217, never a symbol', () => {
  assert.equal(readCurrency({ offers: { priceCurrency: '$' } }, {}, 'amazon.com'), 'USD');
  assert.equal(readCurrency({ offers: { priceCurrency: 'USD' } }, {}, 'walmart.com'), 'USD');
  assert.equal(readCurrency({ offers: { priceCurrency: '€' } }, {}, 'amazon.de'), 'EUR');
});

test('readCurrency resolves an ambiguous dollar sign by marketplace', () => {
  assert.equal(readCurrency({ offers: { priceCurrency: '$' } }, {}, 'amazon.ca'), 'CAD');
  assert.equal(readCurrency({ offers: { priceCurrency: '$' } }, {}, 'amazon.com.au'), 'AUD');
  assert.equal(readCurrency({ offers: {} }, {}, 'ebay.com'), 'USD');
});

test('readStock is three-valued', () => {
  assert.equal(readStock({ additionalProperties: { inStock: true } }), true);
  assert.equal(readStock({ additionalProperties: { inStock: false } }), false);
  assert.equal(readStock({ offers: { availability: 'https://schema.org/InStock' } }), true);
  assert.equal(readStock({ offers: { availability: 'OutOfStock' } }), false);
  // Absent is not the same as out of stock. Walmart and eBay report nothing.
  assert.equal(readStock({ offers: {} }), null);
});

test('canonicalUrl keeps a SKU stable across days', () => {
  // Variant and tracking parameters change per request; without stripping them
  // the same product arrives as a new sku_key and never builds a baseline.
  assert.equal(
    canonicalUrl('https://www.walmart.com/ip/Coat/12970717754?classType=VARIANT'),
    'https://www.walmart.com/ip/Coat/12970717754'
  );
  assert.equal(canonicalUrl('https://www.amazon.com/dp/B0DG5FNXZN/'), 'https://www.amazon.com/dp/B0DG5FNXZN');
  assert.equal(canonicalUrl('https://www.ebay.com/itm/123#desc'), 'https://www.ebay.com/itm/123');
  assert.equal(canonicalUrl(''), null);
});
