-- Tests the detection views against a real Postgres.
--
--   npm run test:sql          (needs a Postgres 15+ you can create a database on)
--
-- Every scenario below is a defect that shipped once. The view is the only place
-- the workflow decides what counts as news, so "coherent on inspection" is not
-- good enough: a view that reads correctly and alerts daily is indistinguishable
-- from a working one until someone mutes the channel.

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- Twenty days of flat history at 100.00 for every SKU, then one capture today.
insert into pricing.price_history (sku_key, product_url, retailer, product_name, price, currency, in_stock, capture_date)
select s.sku, s.sku, 'amazon.com', s.sku, 100.00, 'USD', true, current_date - d
from (values ('A'), ('B'), ('C'), ('D'), ('F'), ('G')) as s(sku)
cross join generate_series(1, 20) as d;

-- E gets a long-stale history and only three recent observations, which is the
-- shape that used to clear a gate that counted every row ever recorded.
insert into pricing.price_history (sku_key, product_url, retailer, product_name, price, currency, in_stock, capture_date)
select 'E', 'E', 'amazon.com', 'E', 100.00, 'USD', true, current_date - d
from generate_series(1, 3) as d
union all
select 'E', 'E', 'amazon.com', 'E', 100.00, 'USD', true, current_date - d
from generate_series(40, 60) as d;

-- G dipped to 85.00 once, three weeks ago, so its 90-day low is already 85.00.
update pricing.price_history set price = 85.00 where sku_key = 'G' and capture_date = current_date - 18;

-- A already fell to its low yesterday. D was already out of stock yesterday.
update pricing.price_history set price = 85.00 where sku_key = 'A' and capture_date = current_date - 1;
update pricing.price_history set in_stock = false, price = null where sku_key = 'D' and capture_date = current_date - 1;

insert into pricing.price_history (sku_key, product_url, retailer, product_name, price, currency, in_stock, capture_date) values
  ('A', 'A', 'amazon.com', 'holds at its 90-day low',   85.00, 'USD', true,  current_date),
  ('B', 'B', 'amazon.com', 'fell today',                85.00, 'USD', true,  current_date),
  ('C', 'C', 'amazon.com', 'went out of stock today',    null, 'USD', false, current_date),
  ('D', 'D', 'amazon.com', 'still out of stock',         null, 'USD', false, current_date),
  ('E', 'E', 'amazon.com', 'no recent baseline',        50.00, 'USD', true,  current_date),
  ('F', 'F', 'amazon.com', 'rose today',               115.00, 'USD', true,  current_date),
  ('G', 'G', 'amazon.com', 'matches its low, not below', 85.00, 'USD', true,  current_date);


do $$
declare
  alerting text[];
  expected text[] := array['B', 'C', 'F', 'G'];
  row_b record;
  row_f record;
  row_g record;
  obs_e int;
begin
  select coalesce(array_agg(sku_key order by sku_key), '{}') into alerting
  from pricing.price_moves_today;

  if alerting is distinct from expected then
    raise exception 'expected % to alert, got %', expected, alerting;
  end if;

  -- A: a product resting at its low is not news a second time. With <= instead
  -- of <, this fired every morning until the price moved again.
  if 'A' = any(alerting) then
    raise exception 'A alerted while merely holding its 90-day low';
  end if;

  -- D: an out-of-stock test that reads the condition rather than the change
  -- repeats for as long as the product stays out of stock.
  if 'D' = any(alerting) then
    raise exception 'D alerted while merely staying out of stock';
  end if;

  -- E: 3 observations inside the window, 21 outside it. Counting all history
  -- let this pass as an established pattern on a 50% move.
  select observations_30d into obs_e from pricing.price_baseline where sku_key = 'E';
  if obs_e <> 3 then
    raise exception 'E should have 3 observations in the 30-day window, has %', obs_e;
  end if;
  if 'E' = any(alerting) then
    raise exception 'E alerted without a recent baseline';
  end if;

  select * into row_b from pricing.price_moves_today where sku_key = 'B';
  if row_b.direction <> 'down' then raise exception 'B direction was %', row_b.direction; end if;
  if not row_b.is_new_90d_low then raise exception 'B should be a new 90-day low'; end if;
  if row_b.prev_price <> 100.00 then raise exception 'B prev_price was %', row_b.prev_price; end if;

  -- C: a product that loses its price when it goes out of stock used to vanish
  -- from detection, because the day's CTE filtered null prices out.
  if not (select went_out_of_stock from pricing.price_moves_today where sku_key = 'C') then
    raise exception 'C should be flagged as having gone out of stock';
  end if;

  -- F: the README promised moves outside the pattern; only falls were detected.
  select * into row_f from pricing.price_moves_today where sku_key = 'F';
  if row_f.direction <> 'up' then raise exception 'F direction was %', row_f.direction; end if;

  -- G: moving onto the existing low is a move, so it alerts, but it is not a
  -- NEW low. With <= it was labelled one, which is how a product that merely
  -- returned to a price it had already touched got announced as a record.
  select * into row_g from pricing.price_moves_today where sku_key = 'G';
  if row_g.is_new_90d_low then
    raise exception 'G matched its 90-day low and was labelled a new one';
  end if;
  if row_g.direction <> 'down' then raise exception 'G direction was %', row_g.direction; end if;

  raise notice 'schema: 7 scenarios passed';
end
$$;

rollback;
