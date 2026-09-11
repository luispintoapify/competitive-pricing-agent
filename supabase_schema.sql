-- Competitive pricing agent · price history store
-- Works on Supabase or any Postgres 12+.
-- Run once before importing the n8n workflow.

create table if not exists price_history (
  id            bigserial primary key,
  captured_at   timestamptz not null default now(),
  capture_date  date        not null default (now()::date),
  sku_key       text        not null,          -- stable identity you track on; the product URL by default
  product_url   text        not null,
  retailer      text,                          -- hostname, e.g. amazon.com
  product_name  text,
  brand         text,
  price         numeric(12,2),
  currency      text,
  in_stock      boolean,                       -- null means the source did not report availability
  image_url     text,
  raw           jsonb                          -- full Actor output, so you can backfill new columns later
);

-- One row per SKU per day. Re-running the workflow the same day updates instead of duplicating.
create unique index if not exists price_history_sku_day
  on price_history (sku_key, capture_date);

create index if not exists price_history_sku_time
  on price_history (sku_key, captured_at desc);


-- Trailing baseline per SKU. Today is excluded so the comparison is never self-referential.
create or replace view price_baseline as
select
  sku_key,
  max(retailer) as retailer,
  count(*) filter (where capture_date < current_date) as observations,
  min(capture_date) as first_seen,
  avg(price)         filter (where capture_date < current_date and capture_date >= current_date - interval '30 days') as avg_price_30d,
  stddev_samp(price) filter (where capture_date < current_date and capture_date >= current_date - interval '30 days') as stddev_price_30d,
  min(price)         filter (where capture_date < current_date and capture_date >= current_date - interval '90 days') as min_price_90d,
  max(price)         filter (where capture_date < current_date and capture_date >= current_date - interval '90 days') as max_price_90d
from price_history
where price is not null
group by sku_key;


-- Detection. Returns only SKUs worth a human's attention today.
--
-- The observations >= 14 guard is deliberate: with less than 14 prior days there is no
-- pattern, so the workflow stays silent rather than claiming one. Lower it and the agent
-- starts reasoning about noise.
create or replace view price_moves_today as
with today as (
  select sku_key, retailer, product_name, brand, price, currency, in_stock, product_url
  from price_history
  where capture_date = current_date and price is not null
)
select
  t.sku_key,
  t.retailer,
  t.product_name,
  t.brand,
  t.product_url,
  t.currency,
  t.price                                                                            as price_today,
  b.observations,
  round(b.avg_price_30d, 2)                                                          as avg_price_30d,
  round(b.min_price_90d, 2)                                                          as min_price_90d,
  round(((t.price - b.avg_price_30d) / nullif(b.avg_price_30d, 0) * 100)::numeric, 1) as pct_vs_avg_30d,
  (t.price <= b.min_price_90d)                                                       as is_new_90d_low,
  case
    when b.stddev_price_30d is null or b.stddev_price_30d = 0 then null
    else round(((t.price - b.avg_price_30d) / b.stddev_price_30d)::numeric, 2)
  end                                                                                as z_score,
  t.in_stock
from today t
join price_baseline b using (sku_key)
where b.observations >= 14
  and (
       t.price <= b.avg_price_30d * 0.95   -- 5% or more below the 30-day average
    or t.price <= b.min_price_90d          -- new 90-day low
    or t.in_stock is false                 -- went out of stock
  );
