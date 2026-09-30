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

// ---------------------------------------------------------------------------
// Graph and layout
// ---------------------------------------------------------------------------
// The connections object is keyed by node NAME and its values name nodes too.
// Renaming a node without rewriting it leaves every edge pointing at a name
// that no longer exists, and n8n imports that as a canvas of disconnected
// nodes rather than refusing it. There is no error to notice.

const NODE_W = 200;
const NODE_H = 100;
const STICKY_TEXT_BAND = 140;

const nodeNames = new Set(workflow.nodes.map((n) => n.name));

test('every connection endpoint is a node that exists', () => {
  const conns = workflow.connections;
  assert.ok(Object.keys(conns).length > 0, 'the workflow must have connections');
  for (const [source, outputs] of Object.entries(conns)) {
    assert.ok(nodeNames.has(source), `connections key "${source}" is not a node`);
    for (const branches of Object.values(outputs)) {
      for (const branch of branches) {
        for (const edge of branch ?? []) {
          assert.ok(nodeNames.has(edge.node), `"${source}" connects to "${edge.node}", which is not a node`);
        }
      }
    }
  }
});

test('every node except the trigger is reachable from the trigger', () => {
  const conns = workflow.connections;
  const trigger = workflow.nodes.find((n) => n.type.endsWith('scheduleTrigger'));
  assert.ok(trigger, 'the workflow must have a trigger');

  const seen = new Set([trigger.name]);
  const queue = [trigger.name];
  while (queue.length) {
    for (const branches of Object.values(conns[queue.pop()] ?? {})) {
      for (const branch of branches) {
        for (const edge of branch ?? []) {
          if (!seen.has(edge.node)) { seen.add(edge.node); queue.push(edge.node); }
        }
      }
    }
  }
  // Sub-nodes attach to their parent rather than being fed by it.
  const subNodes = new Set(Object.keys(conns).filter((s) => conns[s].ai_languageModel));
  const orphans = workflow.nodes
    .filter((n) => n.type !== 'n8n-nodes-base.stickyNote')
    .map((n) => n.name)
    .filter((name) => !seen.has(name) && !subNodes.has(name));
  assert.deepEqual(orphans, [], 'these nodes are not reachable from the trigger');
});

test('no node sits under sticky note text', () => {
  // The reason a reviewer rejects a template: the heading of a note printed on
  // top of a node. A note may frame its nodes, but they belong below its text.
  const stickies = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
  const nodes = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');

  for (const s of stickies) {
    const [sx, sy] = s.position;
    const band = { x1: sx, y1: sy, x2: sx + (s.parameters.width ?? 240), y2: sy + STICKY_TEXT_BAND };
    for (const n of nodes) {
      const [nx, ny] = n.position;
      const box = { x1: nx, y1: ny, x2: nx + NODE_W, y2: ny + NODE_H };
      const hits = box.x1 < band.x2 && box.x2 > band.x1 && box.y1 < band.y2 && box.y2 > band.y1;
      assert.ok(!hits, `"${n.name}" overlaps the text of "${s.name}"`);
    }
  }
});

test('no two nodes overlap each other', () => {
  const nodes = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [ax, ay] = nodes[i].position;
      const [bx, by] = nodes[j].position;
      const hits = ax < bx + NODE_W && ax + NODE_W > bx && ay < by + NODE_H && ay + NODE_H > by;
      assert.ok(!hits, `"${nodes[i].name}" and "${nodes[j].name}" overlap`);
    }
  }
});
