-- Run this in the SQL editor right after the workflow's first successful run.
--
-- It answers one question: did the pipeline write data you can trust, or data
-- that merely looks like data. Every check below corresponds to a defect that
-- shipped once and wrote plausible, wrong rows for days before anyone noticed.
--
-- Read the `verdict` column. Anything other than "ok" is worth stopping for.

with today as (
  select * from pricing.price_history where capture_date = current_date
)
select 'rows written today' as check,
       count(*)::text as value,
       case when count(*) > 0 then 'ok' else 'NOTHING WAS WRITTEN' end as verdict
from today

union all
select 'retailers covered',
       coalesce(string_agg(distinct retailer, ', '), 'none'),
       case when count(distinct retailer) > 0 then 'ok' else 'check the watchlist' end
from today

union all
-- A price that failed to parse lands as null. One or two is a page that
-- changed; all of them is a broken parser.
select 'rows with no price',
       count(*) filter (where price is null)::text,
       case when count(*) filter (where price is null) = 0 then 'ok'
            when count(*) filter (where price is null) < count(*) then 'partial, check the collection warning'
            else 'NO PRICES PARSED' end
from today

union all
-- Currency must be an ISO code. A stored symbol means the mapping was skipped,
-- and rows from different markets stop being comparable.
select 'non-ISO currency values',
       coalesce(string_agg(distinct currency, ', ') filter (where currency is not null and currency !~ '^[A-Z]{3}$'), 'none'),
       case when count(*) filter (where currency is not null and currency !~ '^[A-Z]{3}$') = 0
            then 'ok' else 'SYMBOL STORED INSTEAD OF ISO CODE' end
from today

union all
-- The shape that stringified an object and wrote it as a brand name.
select 'brand literally "[object Object]"',
       count(*) filter (where brand = '[object Object]')::text,
       case when count(*) filter (where brand = '[object Object]') = 0 then 'ok' else 'BRAND PARSING REGRESSED' end
from today

union all
-- A separator misread inflates or deflates a price by a factor of 100 or more:
-- 12,99 becoming 1299, or 1.299,99 becoming 1.29999.
--
-- This check is a net, not a proof. The column is numeric(12,2), so 1.29999 is
-- rounded to 1.30 on write and the deflating case loses its fingerprint before
-- anyone can see it. The unit tests in test/normalize.test.mjs are the real
-- guard; this catches the inflating case and anything wildly out of range.
select 'prices outside 1.00 - 10000',
       count(*) filter (where price is not null and (price < 1 or price > 10000))::text,
       case when count(*) filter (where price is not null and (price < 1 or price > 10000)) = 0
            then 'ok' else 'CHECK THE DECIMAL SEPARATOR' end
from today

union all
-- From day two onward, a parser regression shows up as an impossible overnight
-- move. This is the check that would actually have caught 1.299,99 read as 1.30.
select 'price moved more than 90% overnight',
       (select count(*)::text from pricing.price_moves_today
        where prev_price is not null and price_today is not null
          and abs(price_today - prev_price) / nullif(prev_price, 0) > 0.9),
       case when (select count(*) from pricing.price_moves_today
                  where prev_price is not null and price_today is not null
                    and abs(price_today - prev_price) / nullif(prev_price, 0) > 0.9) = 0
            then 'ok' else 'LOOKS LIKE A PARSING REGRESSION, NOT A SALE' end

union all
-- Tracking parameters in the key mean the same product arrives as a new SKU
-- tomorrow, so it never accumulates a baseline and never alerts.
select 'sku_key carrying query strings',
       count(*) filter (where sku_key like '%?%')::text,
       case when count(*) filter (where sku_key like '%?%') = 0 then 'ok' else 'URLS NOT CANONICALIZED' end
from today

union all
select 'duplicate SKUs today',
       (select count(*)::text from (select sku_key from today group by sku_key having count(*) > 1) d),
       case when (select count(*) from (select sku_key from today group by sku_key having count(*) > 1) d) = 0
            then 'ok' else 'the daily unique index is not doing its job' end

union all
-- Expected to be silent for the first two weeks. Detection needs 14 recent
-- observations before it will claim a pattern exists.
select 'SKUs with enough history to alert',
       (select count(*)::text from pricing.price_baseline where observations_30d >= 14),
       'informational: 0 is correct until day 14'

union all
select 'alerts the workflow would send today',
       (select count(*)::text from pricing.price_moves_today),
       'informational: 0 is correct until day 14';
