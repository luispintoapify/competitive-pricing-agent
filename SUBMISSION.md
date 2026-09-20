# n8n template submission

Everything to paste into the submission form, in the order the form asks for it.

---

## Title

```
Monitor competitor prices with Apify and post repricing alerts to Slack
```

Follows n8n's required shape: action verb, the thing being manipulated, where it
goes. Sentence case, main nodes named, no emoji, no hype.

---

## Description

Paste the Markdown below as-is. It is the same text as the yellow sticky note
inside the workflow, which n8n's guidelines require.

---

### Who's it for

Ecommerce merchandisers, founders and pricing analysts who need to know when a competitor actually changes price, without reading a daily list of numbers that mostly did not move.

### How it works

Every morning the workflow reads your list of competitor product pages and sends them to the Apify E-commerce Scraping Tool, which handles anti-bot, proxies and per-retailer extraction. There is no scraper here to maintain.

A normalize step reduces per-retailer differences to one shape. Prices are parsed without assuming a locale, so `1.299,99` and `$1,299.99` both read correctly. Currency is stored as an ISO code rather than a symbol. Stock keeps three states, because "not reported" is not the same as "out of stock".

One row per product per day goes to Postgres. A view compares today against the trailing 30-day average and the 90-day low and reports **transitions, not states**, so a rival who cuts a price and holds it is reported once rather than every morning.

An AI agent turns what moved into a recommendation and posts it to Slack. A second branch reports which URLs returned nothing, so a broken page never looks like a quiet market.

**It stays silent for the first 14 days.** A baseline of one day is noise, so the workflow collects and says nothing until a product has 14 recent observations. Day one producing no alert is correct, not broken.

### Setup steps

1. Add the Apify community node. On n8n Cloud, search for it on the canvas; your instance owner must have verified community nodes enabled. Self-hosted, install `@apify/n8n-nodes-apify` under Settings, Community nodes.
2. **Run `supabase_schema.sql` against your database before the first execution.** It creates the `pricing` schema, the `price_history` table and the two views this workflow queries. Without it the first run fails with `relation "pricing.price_history" does not exist`. **The full SQL is in the red sticky note on the canvas**, so you do not need anything outside this template.
3. Add credentials: Apify, Postgres, a chat model, and Slack.
4. Open **Select Pages to Monitor** and replace the example URLs with yours, then set your Slack channel.
5. Check your instance timezone under Settings. The schedule says 6am and n8n reads that in the instance timezone, not yours.
6. Run once manually and confirm a row landed in `pricing.price_history`.

### Requirements

- **Postgres 15 or later**, or a Supabase project. Version 15 is the floor because the views use `security_invoker`. The schema puts everything in a private schema with RLS enabled, so on Supabase the table is never exposed through the Data API.
- An Apify account. The Actor is pay per event, roughly $0.006 to $0.0096 per product per day, so a 25-product watchlist costs about $7 a month.
- A chat model credential and a Slack workspace.

### Customization

The thresholds live in one SQL view: the 5% band against the 30-day average, the 90-day low and high, and the 14-day baseline gate. Change them there and the agent follows, because detection is deterministic and the model only writes.

Swap Slack for email, Sheets or a webhook by replacing one node. To watch a category rather than fixed products, run the Actor in keyword mode once to harvest URLs and then pin them: keyword results drift daily and cannot produce a price series.

---

## Pricing

**Free.**

n8n requires at least 3 published templates before an account can offer paid ones,
so free is the only option for a first submission regardless.

---

## Still needed before you submit

**A workflow image.** Still required. n8n's guidelines require one at the top of the description
for any template that uses a community node, because the canvas preview does not
render for those. Export it from the n8n editor: open the workflow, select all,
then use the download-image option in the canvas menu.

**One end-to-end run.** See the note in the repo README. The SQL and the normalize
step are tested, the n8n wiring is not.
