-- Q3: Top 100 users by number of purchases in last 90 days, with signup date
SELECT
  u.user_id,
  u.signup_ts,
  COUNT(*) AS purchase_count
FROM
  events e
JOIN
  users u ON e.user_id = u.user_id
WHERE
  e.event_type = 'purchase'
  AND e.event_ts >= NOW() - INTERVAL '90 days'
GROUP BY
  u.user_id, u.signup_ts
ORDER BY
  purchase_count DESC
LIMIT 100;
