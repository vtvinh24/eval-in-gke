-- Q4: Average purchase amount per country in the last 30 days
-- Shows country, average purchase amount and purchase count for recent purchases
SELECT
  u.country,
  AVG((e.payload->>'amount')::numeric) AS avg_purchase_amount,
  COUNT(*) AS purchase_count
FROM events e
JOIN users u ON e.user_id = u.user_id
WHERE e.event_type = 'purchase'
  AND e.event_ts >= NOW() - INTERVAL '30 days'
  AND (e.payload->>'amount') IS NOT NULL
GROUP BY u.country
ORDER BY avg_purchase_amount DESC;
