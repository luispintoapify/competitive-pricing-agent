-- Competitive pricing agent · price history store
-- Requires Postgres 15 or later, which Supabase satisfies. The views use
-- security_invoker, added in 15.
-- Run once before importing the n8n workflow.


-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
-- Everything lives in its own schema rather than in `public`.
--
-- On Supabase, `public` is exposed through the Data API, so a table created
-- there is reachable with an anon key unless you lock it down yourself. This
-- table holds competitor URLs, a full price history and the raw Actor payload.
-- None of that belongs on a public API surface, so it is kept out of `public`
-- entirely instead of being published and then restricted.
create schema if not exists pricing;

create table if not exists pricing.price_history (
  id            bigserial primary key,
  captured_at   timestamptz not null default now(),
  capture_date  date        not null default (now()::date),
  sku_key       text        not null,          -- stable identity you track on; the canonical product URL by default
  product_url   text        not null,
  retailer      text,                          -- hostname, e.g. amazon.com
  product_name  text,
  brand         text,
  price         numeric(12,2),
  currency      text,                          -- ISO 4217, e.g. USD; the workflow maps symbols before writing
  in_stock      boolean,                       -- null means the source did not report availability
  image_url     text,
  raw           jsonb                          -- full Actor output, so you can backfill new columns later
);

-- Defence in depth. Even in a private schema, RLS means that a leaked anon or
-- authenticated role reads nothing. No policy is created here, and that is the
-- point: no policy means no access. n8n connects as the table owner or as
-- service_role, and both bypass RLS, so the workflow is unaffected.
alter table pricing.price_history enable row level security;

-- Supabase ships the `anon` and `authenticated` roles. Plain Postgres does not,
-- so the revoke is guarded and this file stays runnable on both.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema pricing from anon, authenticated;
    revoke all on all tables in schema pricing from anon, authenticated;
    revoke all on all sequences in schema pricing from anon, authenticated;
    alter default privileges in schema pricing revoke all on tables from anon, authenticated;
  end if;
end
$$;

-- One row per SKU per day. Re-running the workflow the same day updates instead of duplicating.
create unique index if not exists price_history_sku_day
  on pricing.price_history (sku_key, capture_date);

create index if not exists price_history_sku_time
  on pricing.price_history (sku_key, captured_at desc);


-- ---------------------------------------------------------------------------
-- Baseline
-- ---------------------------------------------------------------------------
-- Trailing baseline per SKU. Today is excluded so the comparison is never
-- self-referential.
--
-- security_invoker makes the view run with the caller's permissions. Without it
-- a view runs as its owner and quietly hands out rows that RLS on the table
-- would have refused.
create or replace view pricing.price_baseline
with (security_invoker = true) as
select
  sku_key,
  max(retailer) as retailer,
  -- Counted inside the same 30-day window that feeds the average and the
  -- deviation, so "14 observations" means 14 recent ones. Counting all history
  -- let a SKU with a handful of old rows and one capture this week clear the
  -- gate and be described as having an established pattern.
  count(*) filter (where capture_date <  current_date
                     and capture_date >= current_date - interval '30 days') as observations_30d,
  min(capture_date) as first_seen,
  avg(price)         filter (where capture_date <  current_date
                               and capture_date >= current_date - interval '30 days') as avg_price_30d,
  stddev_samp(price) filter (where capture_date <  current_date
                               and capture_date >= current_date - interval '30 days') as stddev_price_30d,
  min(price)         filter (where capture_date <  current_date
                               and capture_date >= current_date - interval '90 days') as min_price_90d,
  max(price)         filter (where capture_date <  current_date
                               and capture_date >= current_date - interval '90 days') as max_price_90d
from pricing.price_history
where price is not null
group by sku_key;


-- ---------------------------------------------------------------------------
-- Detection
-- ---------------------------------------------------------------------------
-- Returns only SKUs worth a human's attention today.
--
-- Every condition here is a TRANSITION, not a state. That distinction is the
-- difference between a useful alert and a daily reminder that yesterday
-- happened: a competitor who cuts a price and then holds it should be reported
-- once, not every morning until the 30-day average catches up.
--
-- The observations_30d >= 14 guard is deliberate: with fewer than 14 recent
-- days there is no pattern, so the workflow stays silent rather than claiming
-- one. Lower it and the agent starts reasoning about noise.
create or replace view pricing.price_moves_today
with (security_invoker = true) as
with today as (
  -- price is deliberately NOT filtered here. A product that goes out of stock
  -- often stops reporting a price at the same moment, and that transition is
  -- precisely the event worth knowing about. Filtering nulls made stock changes
  -- invisible exactly when they mattered.
  select sku_key, retailer, product_name, brand, price, currency, in_stock, product_url
  from pricing.price_history
  where capture_date = current_date
),
previous as (
  -- The most recent capture before today, which is what "changed" is measured
  -- against. Using the previous observation rather than yesterday's date keeps
  -- this correct across a missed run.
  select distinct on (sku_key)
    sku_key,
    price        as prev_price,
    in_stock     as prev_in_stock,
    capture_date as prev_capture_date
  from pricing.price_history
  where capture_date < current_date
  order by sku_key, capture_date desc
)
select
  t.sku_key,
  t.retailer,
  t.product_name,
  t.brand,
  t.product_url,
  t.currency,
  t.price                                                                            as price_today,
  p.prev_price,
  p.prev_capture_date,
  b.observations_30d,
  round(b.avg_price_30d, 2)                                                          as avg_price_30d,
  round(b.min_price_90d, 2)                                                          as min_price_90d,
  round(b.max_price_90d, 2)                                                          as max_price_90d,
  round(((t.price - b.avg_price_30d) / nullif(b.avg_price_30d, 0) * 100)::numeric, 1) as pct_vs_avg_30d,
  -- Strictly below. With <=, a product resting at its 90-day low was announced
  -- as a new low every single day.
  (t.price < b.min_price_90d)                                                        as is_new_90d_low,
  case
    when t.price is null or p.prev_price is null then null
    when t.price < p.prev_price                  then 'down'
    when t.price > p.prev_price                  then 'up'
  end                                                                                as direction,
  (t.in_stock is false and p.prev_in_stock is true)                                  as went_out_of_stock,
  (t.in_stock is true  and p.prev_in_stock is false)                                 as came_back_in_stock,
  case
    when b.stddev_price_30d is null or b.stddev_price_30d = 0 then null
    else round(((t.price - b.avg_price_30d) / b.stddev_price_30d)::numeric, 2)
  end                                                                                as z_score,
  t.in_stock
from today t
join pricing.price_baseline b using (sku_key)
left join previous p using (sku_key)
where b.observations_30d >= 14
  and (
        -- A price event fires only on the day the price actually moves.
        (
              t.price is distinct from p.prev_price
          and t.price is not null
          and (
                 t.price <= b.avg_price_30d * 0.95   -- 5% or more below the 30-day average
              or t.price >= b.avg_price_30d * 1.05   -- 5% or more above it; a rise is a move too
              or t.price <  b.min_price_90d          -- new 90-day low
              or t.price >  b.max_price_90d          -- new 90-day high
          )
        )
        -- Stock events fire on the change, not on the condition.
     or (t.in_stock is false and p.prev_in_stock is true)
     or (t.in_stock is true  and p.prev_in_stock is false)
  );
