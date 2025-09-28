-- Drop tables if they exist
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS devices CASCADE;

-- Create users table
CREATE TABLE users (
    user_id   BIGINT PRIMARY KEY,
    signup_ts TIMESTAMP,
    country   CHAR(2),
    plan      VARCHAR(20)
);

-- Create devices table
CREATE TABLE devices (
    device_id   BIGINT PRIMARY KEY,
    device_type VARCHAR(30),
    os_version  VARCHAR(20)
);

-- Create events table
CREATE TABLE events (
    event_id   BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL,
    device_id  BIGINT,
    event_type VARCHAR(50),
    event_ts   TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    payload    JSONB
);

-- Populate users with :users_count random rows (default 50,000, 10k+ requirement)
INSERT INTO users (user_id, signup_ts, country, plan)
SELECT g,
             NOW() - (random() * INTERVAL '365 days'),
             (ARRAY['US','VN','IN','GB','DE','FR','JP','CN','BR','RU'])[floor(random()*10)+1],
             (ARRAY['free','basic','pro','enterprise'])[floor(random()*4)+1]
FROM generate_series(1, :users_count) AS g;

-- Populate devices with :devices_count random rows (default 20,000, 10k+ requirement)
INSERT INTO devices (device_id, device_type, os_version)
SELECT g,
             (ARRAY['mobile','tablet','desktop','laptop','iot'])[floor(random()*5)+1],
             'v' || (floor(random()*10)+1) || '.' || (floor(random()*10))
FROM generate_series(1, :devices_count) AS g;

-- Populate events with :events_count random rows (default 200,000, 50k+ requirement)
INSERT INTO events (user_id, device_id, event_type, event_ts, payload)
SELECT 
    (floor(random()*:users_count)+1)::bigint, -- user_id (random in 1..:users_count)
    (floor(random()*:devices_count)+1)::bigint, -- device_id (random in 1..:devices_count)
    (ARRAY['click','view','purchase','login','logout','signup','upgrade','download','error','custom'])[floor(random()*10)+1],
    NOW() - (random() * INTERVAL '120 days'),
        jsonb_build_object(
            'flag', (random() > 0.8),
            'amount', round((random()*100)::numeric,2),
            'meta', (ARRAY['A','B','C','D','E'])[floor(random()*5)+1]
        )
FROM generate_series(1, :events_count);
