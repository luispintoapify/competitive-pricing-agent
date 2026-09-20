# n8n template submission

Everything to paste into the submission form, in the order the form asks for it.

---

## Title

```
Track competitor prices with Apify and post unusual moves to Slack
```

Follows n8n's required shape: action verb, the thing being manipulated, where it
goes. Sentence case, main nodes named, no emoji, no hype.

---

## Description

Paste the Markdown below as-is.

---

## Who's it for

Ecommerce merchandisers, founders and pricing analysts who need to know when a competitor actually changes price, without reading a daily list of numbers that mostly did not move.

## What it does

Every morning it reads your list of competitor product URLs and sends them to the Apify E-commerce Scraping Tool, which handles anti-bot, proxies and per-retailer extraction. There is no scraper to maintain here.

A normalize step reduces per-retailer differences to one shape. Prices are parsed without assuming a locale, so `1.299,99` and `$1,299.99` both read correctly. Currency is stored as an ISO code rather than a symbol. Stock keeps three states, because "not reported" is not the same as "out of stock".

One row per product per day goes to Postgres. A view compares today against the trailing 30-day average and the 90-day low and reports **transitions, not states**, so a rival who cuts a price and holds it is reported once rather than every morning. It stays silent for the first 14 days, because a baseline of one day is noise.

An AI agent turns what moved into a recommendation and posts it to Slack. A second branch reports which URLs returned nothing, so a broken page cannot look like a quiet market.

## How to set up

1. Add the Apify community node. On n8n Cloud, search for it on the canvas; your instance owner must have verified community nodes enabled. Self-hosted, install `@apify/n8n-nodes-apify` under Settings, Community nodes.
2. Run the schema in `supabase_schema.sql` (linked in the sticky note) against Postgres 15 or later. It creates a private schema with RLS enabled, so the table is never exposed through Supabase's Data API.
3. Add credentials: Apify, Postgres, a chat model, Slack.
4. Open **Pages to watch** and replace the example URLs with yours, and set your Slack channel.
5. Check your instance timezone. The schedule says 06:00 and n8n reads that in the instance timezone.
6. Run once manually and confirm a row landed in `pricing.price_history`.

## Requirements

- An Apify account. The Actor is pay per event, roughly $0.006 to $0.0096 per product per day, so 25 products costs about $7 a month.
- Postgres 15 or later, or a Supabase project. Version 15 is the floor because the views use `security_invoker`.
- A chat model credential and a Slack workspace.

## How to customize

The detection thresholds live in one SQL view: the 5% band against the 30-day average, the 90-day low and high, and the 14-day baseline gate. Change them there and the agent's behaviour follows, because detection is deterministic and the model only writes.

Swap Slack for email, Sheets or a webhook by replacing one node. To watch a category rather than fixed products, run the Actor in keyword mode once to harvest URLs, then pin them: keyword results drift daily and cannot produce a price series.

---

## Pricing

**Free.**

n8n requires at least 3 published templates before an account can offer paid ones,
so free is the only option for a first submission regardless.

---

## Still needed before you submit

**A workflow image.** n8n's guidelines require one at the top of the description
for any template that uses a community node, because the canvas preview does not
render for those. Export it from the n8n editor: open the workflow, select all,
then use the download-image option in the canvas menu.

**One end-to-end run.** See the note in the repo README. The SQL and the normalize
step are tested, the n8n wiring is not.
