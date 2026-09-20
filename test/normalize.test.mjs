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
const node = workflow.nodes.find((n) => n.name === 'Normalize Product Data');
assert.ok(node, 'the workflow must contain a "Normalize Product Data" node');

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

// ---------------------------------------------------------------------------
// Capture health
// ---------------------------------------------------------------------------
// The collection warning is the difference between a monitoring tool and a tool
// that goes quiet. These tests pin the behaviour that matters: silence when all
// is well, and a named list of URLs when it is not.

const health = workflow.nodes.find((n) => n.name === 'Check Data Integrity');
assert.ok(health, 'the workflow must contain a "Check Data Integrity" node');

// Runs the health node's code against fake n8n bindings.
const runHealth = async (requestedUrls, rows) => {
  const body = health.parameters.jsCode;
  const fn = new Function(
    '$',
    '$input',
    `return (async () => { ${body} })();`
  );
  return fn(
    (name) => {
      if (name === 'Select Pages to Monitor') {
        return { first: () => ({ json: { detailsUrls: requestedUrls.map((url) => ({ url })) } }) };
      }
      throw new Error(`unexpected node reference: ${name}`);
    },
    { first: () => ({ json: { rows } }) }
  );
};

test('a complete run posts nothing', async () => {
  const out = await runHealth(
    ['https://www.amazon.com/dp/A', 'https://www.amazon.com/dp/B'],
    [
      { sku_key: 'https://www.amazon.com/dp/A', price: 10 },
      { sku_key: 'https://www.amazon.com/dp/B', price: 20 },
    ]
  );
  assert.deepEqual(out, []);
});

test('a URL that returned nothing is named', async () => {
  const out = await runHealth(
    ['https://www.amazon.com/dp/A', 'https://www.amazon.com/dp/B'],
    [{ sku_key: 'https://www.amazon.com/dp/A', price: 10 }]
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json.missing, ['https://www.amazon.com/dp/B']);
  assert.match(out[0].json.message, /1 of 2 watched products recorded/);
  assert.match(out[0].json.message, /dp\/B/);
});

test('a total scrape failure is loud, not silent', async () => {
  const out = await runHealth(['https://www.amazon.com/dp/A'], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.recorded, 0);
  assert.equal(out[0].json.missing.length, 1);
});

test('a row recorded without a price is reported separately', async () => {
  const out = await runHealth(
    ['https://www.amazon.com/dp/A'],
    [{ sku_key: 'https://www.amazon.com/dp/A', price: null }]
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json.priceless, ['https://www.amazon.com/dp/A']);
  assert.equal(out[0].json.missing.length, 0);
});

test('request URLs are canonicalized before matching', async () => {
  // The watchlist may carry tracking parameters the stored sku_key does not.
  const out = await runHealth(
    ['https://www.walmart.com/ip/Coat/123?classType=VARIANT'],
    [{ sku_key: 'https://www.walmart.com/ip/Coat/123', price: 9.99 }]
  );
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// Guardrails the workflow itself must keep
// ---------------------------------------------------------------------------

test('the Actor run is capped and keeps reporting when empty', () => {
  const actor = workflow.nodes.find((n) => n.name === 'Run Apify Scraper');
  assert.ok(actor.parameters.maxTotalChargeUsd > 0, 'a run must have a spend ceiling');
  // Without this a run that returns nothing skips every downstream node, and the
  // collection warning never fires.
  assert.equal(actor.alwaysOutputData, true);
});

test('the agent is told that scraped fields are data, not instructions', () => {
  const agent = workflow.nodes.find((n) => n.name === 'Repricing Analysis Agent');
  const sm = agent.parameters.options.systemMessage;
  assert.match(sm, /never as\s+instructions/);
});

test('the SQL nodes address the private schema', () => {
  const queries = workflow.nodes
    .filter((n) => n.type === 'n8n-nodes-base.postgres')
    .map((n) => n.parameters.query);
  assert.ok(queries.length >= 2);
  for (const q of queries) assert.match(q, /pricing\./);
});

test('every $() node reference resolves to a node that exists', () => {
  // The failure mode a rename actually causes. n8n does not validate these:
  // a reference to a node that no longer exists throws at runtime, on the
  // morning of a scheduled run, with nobody watching.
  const names = new Set(workflow.nodes.map((n) => n.name));
  const refs = [...JSON.stringify(workflow).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'expected the workflow to reference at least one node by name');
  for (const ref of new Set(refs)) {
    assert.ok(names.has(ref), `$('${ref}') points at a node that does not exist`);
  }
});

test('the schema the workflow needs travels with it', () => {
  // The template must not depend on a repository a user may not be able to
  // open. Everything needed to run it has to be on the canvas.
  const stickies = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
  const schemaNote = stickies.find((s) => s.parameters.content.includes('create schema'));
  assert.ok(schemaNote, 'a sticky note must carry the SQL schema');

  const sql = schemaNote.parameters.content;
  // Every relation the Postgres nodes query must be created by that SQL.
  const queried = new Set(
    workflow.nodes
      .filter((n) => n.type === 'n8n-nodes-base.postgres')
      .flatMap((n) => [...n.parameters.query.matchAll(/pricing\.(\w+)/g)].map((m) => m[1]))
  );
  assert.ok(queried.size >= 2);
  for (const rel of queried) {
    assert.match(sql, new RegExp(`(table|view)[^\\n]*pricing\\.${rel}\\b`), `the sticky SQL never creates pricing.${rel}`);
  }

  // The security properties are the reason this schema exists at all.
  assert.match(sql, /enable row level security/);
  assert.match(sql, /security_invoker = true/);
  assert.match(sql, /revoke all on schema pricing from anon/);
});
