-- Q6: Engaged users who never made a purchase (>= 10 events total)
-- Useful to identify high-activity non-buyers
SELECT
  u.user_id,
  u.signup_ts,
  COUNT(*) AS total_events
FROM users u
JOIN events e ON u.user_id = e.user_id
GROUP BY u.user_id, u.signup_ts
HAVING SUM((e.event_type = 'purchase')::int) = 0
   AND COUNT(*) >= 10
ORDER BY total_events DESC
LIMIT 100;
