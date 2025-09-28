-- Q2: Recent distinct device types used by users from country 'VN' with a specific payload flag
SELECT DISTINCT
  d.device_type
FROM
  events e
JOIN
  users u ON e.user_id = u.user_id
JOIN
  devices d ON e.device_id = d.device_id
WHERE
  u.country = 'VN'
  AND e.event_ts >= NOW() - INTERVAL '30 days'
  AND (e.payload->>'flag')::boolean = true;
