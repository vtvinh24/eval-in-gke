-- Q1: Count of events per event_type for active users in last 30 days
SELECT
  e.event_type,
  COUNT(*) AS event_count
FROM
  events e
JOIN
  users u ON e.user_id = u.user_id
WHERE
  e.event_ts >= NOW() - INTERVAL '30 days'
  AND u.user_id IN (
    SELECT DISTINCT user_id
    FROM events
    WHERE event_ts >= NOW() - INTERVAL '30 days'
  )
GROUP BY
  e.event_type
ORDER BY
  event_count DESC;
