# competitive-pricing-agent

An n8n workflow that watches competitor product pages every day, keeps its own price history, and tells you only when a rival moves outside its established pattern. The reasoning step recommends an action instead of reporting a diff.

Built on [E-commerce Scraping Tool](https://apify.com/apify/e-commerce-scraping-tool?utm_source=github&utm_medium=readme&utm_campaign=gtm-cam-121), an Apify Actor that handles anti-bot, proxies, and per-retailer extraction, so there is no scraper in this repo to maintain.

The problem with most price monitoring is not collecting today's price. It is that a price on its own means nothing. A competitor at $86 is only interesting if you know they normally sell at $100, that they usually discount in late November, and that this year they moved nine days early. That needs memory, and memory needs a table.

## How it works

```
Schedule  ->  E-commerce Scraping Tool  ->  Normalize  ->  Postgres  ->  Detect  ->  Agent  ->  Slack
 daily          price, stock, brand        one shape      history      what moved   decide    alert
```

1. A daily schedule reads the product URLs you list in one Code node.
2. The Actor returns product fields for every URL in a single call.
3. A normalize step reduces per-retailer differences to one stable shape.
4. One row per product per day is written to Postgres or Supabase.
5. A view compares today against the trailing 30-day average and the 90-day low.
6. Anything that moved goes to an AI agent, which writes a recommendation.
7. The recommendation lands in Slack.

## The 14-day rule

The detection view refuses to report anything until a product has **14 days of prior observations**:

```sql
where b.observations >= 14
```

This is deliberate. A workflow installed today has no history, and comparing today's price against a baseline of one day is noise dressed as insight. For the first two weeks the workflow runs, stores, and says nothing. Lower the threshold and you will get alerts, but they will not mean anything.

If you need a baseline sooner than two weeks, backfill the table from your own records rather than shortening the window.

## Why normalizing comes first

This is the part worth copying even if you never run the rest. Field names, types, and nesting differ per retailer, so code that reads them naively works on one store and breaks on the next.

| Field | What actually arrives |
|---|---|
| `price` | A number on some retailers, a string with currency symbols on others |
| currency | `offers.priceCurrency` on some, `offers.currency` on others, and the value may be a symbol or an ISO code |
| stock | Under `additionalProperties.inStock`, or only as `offers.availability`, or absent |
| `brand` | Often carries marketing text such as "Visit the Sony Store" |
| `name` | May carry accessibility suffixes such as "opens in a new tab" |
| everything | An unresolvable URL returns an item with every field empty rather than an error |

Stock keeps **three** states: `true`, `false`, and `null` for unknown. Many retailers do not report availability, and unknown is not the same as out of stock. Mapping one to the other produces false "competitor is out of stock" alerts, which is worse than no alert.

## Setup

1. Import `workflow.n8n.json` into n8n.
2. Run `supabase_schema.sql` against Postgres 12 or later, or a Supabase project. It creates the `price_history` table and the `price_baseline` and `price_moves_today` views.
3. Add an Apify credential on the Actor node. Your token is in Apify Console under **Settings, Integrations**.
4. Add a Postgres credential and select it in both Postgres nodes.
5. Add a credential for your chat model, and a Slack credential with `chat:write`.
6. Open **Pages to watch** and replace the example URLs with yours. Set your Slack channel.
7. Run once manually and confirm a row landed in `price_history`, then activate.

## What it costs

The Actor is pay per event. Prices below are per product per day, at the Free and Bronze tiers, from the Actor's live pricing:

| Event | Free | Bronze |
|---|---|---|
| `push-product` | $0.0060 | $0.0015 |
| `residential-proxy-per-product` | $0.0030 | $0.0010 |
| `browser-rendering-per-product` | $0.0006 | $0.00057 |

Proxy and browser rendering only apply on retailers that need them, so a realistic range is $0.0060 to $0.0096 per product per day on Free.

| Watched | 30 days | 90 days |
|---|---|---|
| 25 products | $4.50 to $7.20 | $13.51 to $21.61 |
| 100 products | $18.00 to $28.80 | $54.01 to $86.41 |
| 300 products | $54.00 to $86.40 | $162.01 to $259.21 |

Start at 25 products, look at your actual bill after a week, then scale. A daily schedule across 300 products is a real recurring cost, not a rounding error.

## Supported retailers

The Actor covers **249 storefronts across 104 retailer brands** for keyword search, including Amazon, Walmart, Target, eBay, Best Buy, Home Depot, IKEA, Costco, Nordstrom, Macy's, Tesco, Mercado Libre, and Idealo. Direct product URLs work more broadly, because the Actor falls back to generic extraction for stores without a dedicated extractor.

Not every retailer is covered, and unsupported domains can return partial data rather than an error. Check the Actor's input schema for the current list before committing a watchlist.

## What the agent will not tell you

The reasoning prompt is deliberately constrained. The agent does not know your cost, your margin, or your price floor, so it is forbidden from stating a margin outcome or a specific price to set. It recommends an action, states the size of the gap, and says how strong the pattern is. Anything more specific would be invented.

## FAQ

**Do I need Supabase specifically?** No. Any Postgres 12 or later works. The schema uses `jsonb` and filtered aggregates, both standard.

**Can I use this without a database?** Not as written. The whole point is the baseline, and a baseline needs somewhere to live. A version that diffs only against the previous run needs no database, but it cannot tell you whether a drop is unusual.

**Why n8n and not a script?** Because the destination changes more often than the logic. Swapping Slack for email, Sheets, or a shopping cart is a node change rather than a rewrite.

**Does this work outside the US?** Yes. The Actor supports localized search across many country codes, and the schema stores currency per row.

**How is this different from price monitoring SaaS?** Those are closed and usually priced per SKU. Here the data lands in your database, the reasoning prompt is a text field you can read and edit, and the destination is yours.

**What happens when a retailer blocks the request?** The Actor handles retries and proxies. The node retries three times. Roughly 4% of this Actor's public runs time out, so a daily schedule will occasionally miss a day, and the views tolerate gaps.

**Can an AI agent query the history directly?** Yes. Connect the same Actor over the [Apify MCP server](https://docs.apify.com/integrations/mcp?utm_source=github&utm_medium=readme&utm_campaign=gtm-cam-121) and ask in plain language.

**Is scraping public product pages legal?** Collecting publicly available information is generally permitted in the US and EU, but it depends on the site's terms and on what you do with the data. Read [Is web scraping legal?](https://blog.apify.com/is-web-scraping-legal/?utm_source=github&utm_medium=readme&utm_campaign=gtm-cam-121) and take your own advice.

## License

MIT. See [LICENSE](LICENSE).
