-- Q5: Daily active users (distinct users per day) for the last 30 days
SELECT
  date_trunc('day', e.event_ts)::date AS day,
  COUNT(DISTINCT e.user_id) AS daily_active_users
FROM events e
WHERE e.event_ts >= NOW() - INTERVAL '30 days'
GROUP BY day
ORDER BY day;
