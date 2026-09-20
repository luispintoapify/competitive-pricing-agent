# competitive-pricing-agent

[![test](https://github.com/luispintoapify/competitive-pricing-agent/actions/workflows/test.yml/badge.svg)](https://github.com/luispintoapify/competitive-pricing-agent/actions/workflows/test.yml)

An n8n workflow that watches competitor product pages every day, keeps its own price history, and tells you only when a rival moves outside its established pattern. The reasoning step recommends an action instead of reporting a diff.

Built on [E-commerce Scraping Tool](https://apify.com/apify/e-commerce-scraping-tool?utm_source=github&utm_medium=readme&utm_campaign=competitive-pricing-agent), an Apify Actor that handles anti-bot, proxies, and per-retailer extraction, so there is no scraper in this repo to maintain.

The problem with price monitoring is not collecting today's price. A price on its own means nothing: a competitor at $86 is only interesting if you know they normally sell at $100, and that this year they discounted nine days earlier than usual. That needs memory, and memory needs a table.

## How it works

```
Schedule -> E-commerce Scraping Tool -> Normalize -> Postgres -> Detect -> Agent -> Slack
  daily        price, stock, brand      one shape    history   what moved  decide  alert
                                             |
                                             +-----> Capture health -> Slack
                                                     what did not arrive
```

1. A daily schedule reads the product URLs you list in one Code node.
2. The Actor returns product fields for every URL in a single call.
3. A normalize step reduces per-retailer differences to one stable shape.
4. One row per product per day is written to Postgres or Supabase.
5. A view compares today against the trailing 30-day average and the 90-day low.
6. Anything that moved goes to an AI agent, which writes a recommendation.
7. The recommendation lands in Slack.

A second branch checks what did **not** arrive. For a monitoring tool, "I received no data" has to be an event: without that check, a page that changes structure or starts blocking simply stops being recorded, and the first sign of trouble is a baseline that never fills. Silence and "nothing moved" look identical otherwise. That warning goes to the same channel but is kept separate from the pricing alert, because a scraping problem is not a price signal.

## The 14-day rule

The detection view refuses to report anything until a product has **14 days of prior observations**:

```sql
where b.observations_30d >= 14
```

This is deliberate. A workflow installed today has no history, and comparing today's price against a baseline of one day is noise dressed as insight. For the first two weeks the workflow runs, stores, and says nothing. Lower the threshold and you will get alerts, but they will not mean anything.

Those 14 observations are counted **inside the same 30-day window** that produces the average and the deviation. Counting all history instead let a product with a handful of old rows and a single capture this week clear the gate and then be described as having an established pattern.

If you need a baseline sooner than two weeks, backfill the table from your own records rather than shortening the window.

## Setup

1. **Add the Apify community node first.** On n8n Cloud, search for it on the canvas; the instance owner must have **verified community nodes** enabled in settings. Self-hosted, add the package `@apify/n8n-nodes-apify` under **Settings, Community nodes**. Without it the import succeeds and the Actor node shows up unrecognized.
2. Import `workflow.n8n.json` into n8n.
3. Run `supabase_schema.sql` against **Postgres 15 or later**, or a Supabase project. It creates the `pricing` schema, the `pricing.price_history` table, and the `price_baseline` and `price_moves_today` views. Postgres 15 is required because the views use `security_invoker`.
4. Add an Apify credential on the Actor node. Your token is in Apify Console under **Settings, Integrations**.
5. Add a Postgres credential and select it in both Postgres nodes. The role you connect with must own the `pricing` schema or be `service_role`; both bypass RLS, which is what lets the workflow write while everyone else is locked out.
6. Add a credential for your chat model, and a Slack credential with `chat:write`.
7. Open **Pages to watch** and replace the example URLs with yours. Set your Slack channel.
8. Check the instance timezone under **Settings, General**. The schedule says 06:00, and n8n reads that in the instance timezone, not yours and not UTC.
9. Run once manually and confirm a row landed in `pricing.price_history`, then activate.

Run `npm test` to check the normalize step against real retailer responses before you trust it with your history. No dependencies.

## What it costs

The Actor is pay per event. The figures below are per product per day at the Free and Bronze tiers, read from the Actor's pricing in **September 2026**. Pricing changes, so check the [Actor page](https://apify.com/apify/e-commerce-scraping-tool?utm_source=github&utm_medium=readme&utm_campaign=competitive-pricing-agent) before budgeting against them.

| Event | Free | Bronze |
|---|---|---|
| `push-product` | $0.0060 | $0.0015 |
| `residential-proxy-per-product` | $0.0030 | $0.0010 |
| `browser-rendering-per-product` | $0.0006 | $0.00057 |

Proxy and browser rendering only apply on retailers that need them, so a realistic range is $0.0060 to $0.0096 per product per day on Free.

At the top of that range, a 25-product watchlist costs about **$7 a month** and 300 products about **$86 a month**. Start at 25, look at your actual bill after a week, then scale. A daily schedule across 300 products is a real recurring cost, not a rounding error.

Two things keep a bad day from becoming an expensive one:

**A ceiling per run.** The Actor node sets `maxTotalChargeUsd`, so a run that goes wrong stops rather than spends. It ships at $1, which comfortably covers a 25-product watchlist. Raise it as your list grows, or the run will stop early and the collection warning will tell you it did.

**Fewer paid retries.** The node retries twice, not three times. A run that hits its time cap has already spent its compute, and retrying it three times spends it three times for the same likely outcome.

Roughly **4.9%** of this Actor's runs timed out over the last 30 days, against an overall success rate near 94%. A timeout is usually a throughput signal rather than a broken URL: the same URL with a smaller `maxProductResults` normally succeeds.

## What is tested, and what is not

`npm test` runs 20 checks with no dependencies. They read the code out of `workflow.n8n.json` rather than from a copy, so they exercise the file you import, not something that can drift away from it.

| Covered | How |
|---|---|
| Price, currency, brand, stock and URL normalization | Unit tests against real Amazon, Walmart and eBay responses, including the European formats that a naive parser silently corrupts |
| The detection views | Seven scenarios against a real Postgres, asserting who alerts today and who stays quiet |
| The collection warning | Silence when every URL returns, a named list when one does not |
| Node references | Every `$('Node name')` resolves, which n8n itself does not check |

`npm run test:sql` needs a `DATABASE_URL` pointing at a Postgres 15 or later you can create objects on. CI runs both suites on every push.

What the suite does not cover is the n8n wiring itself: credentials connecting, the shapes passed between nodes, the agent, and Slack. That is exercised by importing the workflow and running it once, and `test/first_run_check.sql` is there to tell you whether the first run wrote data worth keeping.

## Supported retailers

The Actor's input schema lists **249 storefronts across 104 retailer brands** as valid targets for keyword search. Being on that list is not the same as keyword search returning results.

Measured on September 11, 2026, keyword `winter jacket`, US:

| Retailer | Keyword search | Time |
|---|---|---|
| Amazon | Full page of products | ~15s |
| Walmart | Full page of products | ~15s |
| eBay | Products, but loosely matched | ~39s |
| Target | Completed, returned nothing | 13s |
| Kohl's | Completed, returned nothing | 10s |
| Academy | Completed, returned nothing | 13s |
| Nordstrom | Completed, returned nothing | 39s |
| Macy's | Completed, returned nothing | 21s |

An empty result is not an error. The run succeeds and hands back an empty list, so a collector that assumes every configured retailer produces rows will quietly record nothing for most of them. Test every retailer you plan to watch before you commit to a watchlist. A run that times out is a different diagnosis from one that returns an empty list: the first is a throughput limit and may succeed with a longer cap, the second means search found nothing.

Direct product URLs are the more reliable path. They bypass search entirely, and the Actor falls back to generic extraction for stores without a dedicated extractor. An unresolvable URL returns an item with empty fields rather than an error, which is why the normalize step drops those rows.

## Search first, then pin the URLs

Keyword mode and URL mode answer different questions, and a price study needs both in order.

Keyword mode returns whatever ranks that day, so the set of products drifts. That is what you want for a snapshot of a category's price distribution, and it is useless as a discount series: a price that "changed" may just be a different product in the same slot.

So run keyword mode once, to learn which retailers respond and to harvest real product URLs. Then pin those URLs and switch to URL mode. From that point every capture measures the same items, and a price move is a price move.

Curate the harvested list before pinning it. Keyword results include things a discount study should not track:

- **Promotional titles.** A Walmart listing whose product name begins `Clearance under $5` is a seller's title tactic, not a retail price signal.
- **Category drift.** An eBay search for winter jackets returned a Pokemon championship bomber jacket and a denim jacket.
- **Resale listings.** eBay prices are set by individual sellers, often for used goods. They are a market signal, not a retailer's list price, and they do not fall on Black Friday for the same reasons.

## Why normalizing comes first

This is the part worth copying even if you never run the rest. Every retailer answers a slightly different shape, and code that reads them naively works on one store and writes nonsense on the next. Measured on the runs above:

| | Amazon | Walmart | eBay |
|---|---|---|---|
| `offers.price` | number | string, `"$12.99"` | number |
| `offers.priceCurrency` | symbol, `"$"` | ISO, `"USD"` | ISO, `"USD"` |
| `brand` | object, sometimes `{slogan}` | object with `slogan` | `{name: null}` |
| Stock | boolean in `additionalProperties.inStock` | absent | absent on detail pages |
| `name` | may carry "opens in a new tab" | keyword-stuffed by sellers | seller-written |
| any URL | an unresolvable one returns empty fields, not an error | | |

Four rules follow, and the shipped workflow applies all four. `npm test` checks them against these exact responses.

**Parse the price, never cast it, and never assume a locale.** One retailer hands you a number and another a currency-prefixed string. Stripping everything but digits and dots is the obvious move and it is wrong outside the US: it reads `1.299,99` as `1.29999` and `12,99` as `1299`. Both are plausible numbers, both are silently wrong, and both are permanent once written. The rule that works: when both separators appear, the last one is the decimal separator; when only one appears, it is a decimal separator only if exactly two digits follow it.

**Store ISO 4217, never the symbol.** A row holding `$` cannot be compared with a `$` from another market, and nothing downstream can tell USD from CAD or AUD afterwards. A bare dollar sign is resolved by marketplace: `$` on `amazon.ca` is stored as `CAD`.

**Read only strings out of `brand`.** Falling through to the object stringifies to `[object Object]`, and it does so for the shapes that look harmless, such as `{name: null}`. Amazon also uses `brand.slogan` for copy like `Visit the Carhartt Store`, so unwrap that and reject anything too long to be a brand name.

**Canonicalize the URL you track on.** Marketplaces append variant and tracking parameters that change per request. Keep them and the same product arrives as a new `sku_key` every day, so it never accumulates a baseline and never alerts.

Stock keeps **three** states: `true`, `false`, and `null` for unknown. Absent is not the same as out of stock, and Walmart and eBay do not report availability on detail pages at all. Collapsing unknown into out-of-stock produces false "competitor is out of stock" alerts, which is worse than no alert.

## Two gotchas worth knowing

**`maxProductResults` caps the whole run, not each marketplace.** One call listing three marketplaces with a cap of 30 returned 30 Amazon rows and nothing from the other two. Give each retailer its own call and its own quota.

**The Apify MCP server truncates the marketplace list** to the first 120 entries, cutting off mid-IKEA, so `www.walmart.com` and `www.target.com` are rejected as invalid through MCP even though the Actor accepts them. Read the real list from the public build endpoint, which needs no token:

```bash
curl -s "https://api.apify.com/v2/acts/apify~e-commerce-scraping-tool/builds/default"
```

## What the agent will not tell you

The reasoning prompt is deliberately constrained. The agent does not know your cost, your margin, or your price floor, so it is forbidden from stating a margin outcome or a specific price to set. It recommends an action, states the size of the gap, and says how strong the pattern is. Anything more specific would be invented.

The detection is entirely deterministic. Every threshold, every comparison and every transition is decided in SQL before the model sees anything, so the agent cannot change what counts as a move. It writes; it does not judge.

It is also told that `product_name`, `brand`, `retailer` and `product_url` are scraped from pages nobody here controls, and are data to report rather than instructions to follow. A product title is an open text field on most marketplaces, which makes it a way to send text to whatever reads it. If a title contains something shaped like a directive, the agent is instructed to ignore it, describe the row from the numbers, and say the title looked manipulated.

## FAQ

**Do I need Supabase specifically?** No. Any Postgres 15 or later works. The schema uses `jsonb`, filtered aggregates and `security_invoker` views, all standard. Version 15 is the floor because of `security_invoker`.

**Can I use this without a database?** Not as written. The whole point is the baseline, and a baseline needs somewhere to live. A version that diffs only against the previous run needs no database, but it cannot tell you whether a drop is unusual.

**Does this work outside the US?** Yes. The Actor supports localized search across many country codes, the schema stores an ISO currency per row, and the normalize step parses both `1,299.99` and `1.299,99` correctly.

**What happens when a retailer blocks the request?** The Actor handles retries and proxies, and the node retries twice. Roughly 4.9% of this Actor's runs timed out over the last 30 days, so a daily schedule will occasionally miss a product. The views tolerate gaps, and the collection warning tells you which URLs came back empty rather than letting them disappear quietly.

**Can an AI agent query the history directly?** Yes. Connect the same Actor over the [Apify MCP server](https://docs.apify.com/integrations/mcp?utm_source=github&utm_medium=readme&utm_campaign=competitive-pricing-agent) and ask in plain language.

**Is scraping public product pages legal?** Collecting publicly available information is generally permitted in the US and EU, but it depends on the site's terms and on what you do with the data. Read [Is web scraping legal?](https://blog.apify.com/is-web-scraping-legal/?utm_source=github&utm_medium=readme&utm_campaign=competitive-pricing-agent) and take your own advice.

## License

MIT. See [LICENSE](LICENSE).
