-- Schema smoke tests. Every block raises on failure, so a clean run means
-- every assertion held. Run against a freshly migrated database:
--   psql -v ON_ERROR_STOP=1 -d daybook_dev -f packages/db/tests/schema_smoke.sql

\set ON_ERROR_STOP on
\timing off

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

INSERT INTO users (id, email, password_hash)
VALUES ('11111111-1111-1111-1111-111111111111', 'ada@example.com', 'argon2-placeholder'),
       ('22222222-2222-2222-2222-222222222222', 'grace@example.com', 'argon2-placeholder');

INSERT INTO user_profiles (user_id, display_name, timezone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Ada', 'Africa/Lagos'),
       ('22222222-2222-2222-2222-222222222222', 'Grace', 'Europe/London');

INSERT INTO activity_categories (id, user_id, name, color, is_system, is_fitness)
VALUES ('33333333-3333-3333-3333-333333333333', NULL, 'Fitness', '#2F44C8', true, true);

-- ---------------------------------------------------------------------------
-- 1. An invalid IANA timezone is rejected
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE user_profiles SET timezone = 'Mars/Olympus_Mons'
    WHERE user_id = '11111111-1111-1111-1111-111111111111';
    RAISE EXCEPTION 'FAIL: an invalid timezone was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'ok 1  invalid timezone rejected';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Generated columns compute planned duration and start deviation
-- ---------------------------------------------------------------------------
INSERT INTO activities (id, user_id, occurrence_date, title, category_id,
                        planned_start, planned_end, actual_start, status)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111',
        DATE '2026-08-28', 'Gym', '33333333-3333-3333-3333-333333333333',
        TIMESTAMPTZ '2026-08-28 18:00:00+01',
        TIMESTAMPTZ '2026-08-28 19:30:00+01',
        TIMESTAMPTZ '2026-08-28 18:05:00+01',
        'active');

DO $$
DECLARE planned int; deviation int;
BEGIN
  SELECT planned_duration_minutes, start_deviation_minutes
    INTO planned, deviation
    FROM activities WHERE id = '44444444-4444-4444-4444-444444444444';
  IF planned <> 90 THEN
    RAISE EXCEPTION 'FAIL: planned_duration_minutes was %, expected 90', planned;
  END IF;
  IF deviation <> 5 THEN
    RAISE EXCEPTION 'FAIL: start_deviation_minutes was %, expected 5', deviation;
  END IF;
  RAISE NOTICE 'ok 2  generated columns: 90 planned minutes, +5 minute start';
END $$;

-- ---------------------------------------------------------------------------
-- 3. planned_end must follow planned_start
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO activities (user_id, occurrence_date, title, planned_start, planned_end)
    VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-08-28', 'Backwards',
            TIMESTAMPTZ '2026-08-28 10:00:00+01', TIMESTAMPTZ '2026-08-28 09:00:00+01');
    RAISE EXCEPTION 'FAIL: an inverted planned window was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 3  inverted planned window rejected';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4. A series occurrence can only be materialised once
-- ---------------------------------------------------------------------------
INSERT INTO activity_series (id, user_id, title, rrule, timezone, start_date,
                             start_time, duration_minutes)
VALUES ('55555555-5555-5555-5555-555555555555',
        '11111111-1111-1111-1111-111111111111', 'Gym',
        'FREQ=WEEKLY;BYDAY=MO,WE,TH,SA', 'Africa/Lagos',
        DATE '2026-09-01', TIME '18:00', 90);

INSERT INTO activities (user_id, series_id, occurrence_date, title, source,
                        planned_start, planned_end)
VALUES ('11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', DATE '2026-09-02', 'Gym', 'series',
        TIMESTAMPTZ '2026-09-02 18:00:00+01', TIMESTAMPTZ '2026-09-02 19:30:00+01');

DO $$
BEGIN
  BEGIN
    INSERT INTO activities (user_id, series_id, occurrence_date, title, source,
                            planned_start, planned_end)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '55555555-5555-5555-5555-555555555555', DATE '2026-09-02', 'Gym', 'series',
            TIMESTAMPTZ '2026-09-02 18:00:00+01', TIMESTAMPTZ '2026-09-02 19:30:00+01');
    RAISE EXCEPTION 'FAIL: the same series occurrence materialised twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 4  duplicate series occurrence rejected';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 5. One sync event can only ever create one activity (idempotency guard 4)
-- ---------------------------------------------------------------------------
INSERT INTO domain_events (id, user_id, event_type, aggregate_type, aggregate_id,
                           payload, occurred_at, idempotency_key, source_app)
VALUES ('66666666-6666-6666-6666-666666666666',
        '11111111-1111-1111-1111-111111111111', 'WORKOUT_COMPLETED',
        'workout_session', '77777777-7777-7777-7777-777777777777',
        '{"duration_seconds":4020}'::jsonb, now(),
        '77777777-7777-7777-7777-777777777777:completed', 'fitness');

INSERT INTO activities (user_id, occurrence_date, title, source, origin_event_id,
                        planned_start, planned_end, status)
VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-08-28', 'Unplanned workout',
        'sync', '66666666-6666-6666-6666-666666666666',
        TIMESTAMPTZ '2026-08-28 17:05:00+01', TIMESTAMPTZ '2026-08-28 18:12:00+01', 'completed');

DO $$
BEGIN
  BEGIN
    INSERT INTO activities (user_id, occurrence_date, title, source, origin_event_id,
                            planned_start, planned_end, status)
    VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-08-28', 'Unplanned workout',
            'sync', '66666666-6666-6666-6666-666666666666',
            TIMESTAMPTZ '2026-08-28 17:05:00+01', TIMESTAMPTZ '2026-08-28 18:12:00+01', 'completed');
    RAISE EXCEPTION 'FAIL: one event created two activities';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 5  replayed event cannot create a second activity';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 6. An event reaches a given consumer once
-- ---------------------------------------------------------------------------
INSERT INTO event_deliveries (event_id, consumer)
VALUES ('66666666-6666-6666-6666-666666666666', 'daybook-projector');

DO $$
BEGIN
  BEGIN
    INSERT INTO event_deliveries (event_id, consumer)
    VALUES ('66666666-6666-6666-6666-666666666666', 'daybook-projector');
    RAISE EXCEPTION 'FAIL: the same delivery was queued twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 6  duplicate delivery rejected';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Only one workout can be in progress per user
-- ---------------------------------------------------------------------------
INSERT INTO workout_sessions (id, user_id, started_at, status)
VALUES ('88888888-8888-8888-8888-888888888888',
        '11111111-1111-1111-1111-111111111111', now(), 'in_progress');

DO $$
BEGIN
  BEGIN
    INSERT INTO workout_sessions (user_id, started_at, status)
    VALUES ('11111111-1111-1111-1111-111111111111', now(), 'in_progress');
    RAISE EXCEPTION 'FAIL: two workouts in progress at once';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 7  second in-progress workout rejected';
  END;
END $$;

-- Grace may of course train at the same time.
INSERT INTO workout_sessions (user_id, started_at, status)
VALUES ('22222222-2222-2222-2222-222222222222', now(), 'in_progress');

-- ---------------------------------------------------------------------------
-- 8. An offline workout replayed twice resolves to one session
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO workout_sessions (user_id, started_at, status, client_session_uuid, ended_at)
    VALUES ('22222222-2222-2222-2222-222222222222', now(), 'completed',
            '99999999-9999-9999-9999-999999999999', now());
    INSERT INTO workout_sessions (user_id, started_at, status, client_session_uuid, ended_at)
    VALUES ('22222222-2222-2222-2222-222222222222', now(), 'completed',
            '99999999-9999-9999-9999-999999999999', now());
    RAISE EXCEPTION 'FAIL: a replayed offline workout created a second session';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 8  replayed offline workout deduplicated';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 9. A completed session must carry an end time
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO workout_sessions (user_id, started_at, status)
    VALUES ('22222222-2222-2222-2222-222222222222', now(), 'completed');
    RAISE EXCEPTION 'FAIL: a completed session with no end time was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 9  completed session requires an end time';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 10. A day scores null, never zero, when there was no plan
-- ---------------------------------------------------------------------------
INSERT INTO daily_summaries (user_id, summary_date, productivity_score)
VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-08-30', NULL);

DO $$
BEGIN
  BEGIN
    INSERT INTO daily_summaries (user_id, summary_date, productivity_score)
    VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-08-31', 101);
    RAISE EXCEPTION 'FAIL: an out-of-range score was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 10 score is bounded to 0..100, null allowed';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 11. Deleting an account removes everything it owns
-- ---------------------------------------------------------------------------
DO $$
DECLARE leftovers int;
BEGIN
  DELETE FROM users WHERE id = '22222222-2222-2222-2222-222222222222';
  SELECT count(*) INTO leftovers FROM workout_sessions
    WHERE user_id = '22222222-2222-2222-2222-222222222222';
  IF leftovers <> 0 THEN
    RAISE EXCEPTION 'FAIL: % workout rows survived account deletion', leftovers;
  END IF;
  RAISE NOTICE 'ok 11 account deletion cascades';
END $$;

-- ---------------------------------------------------------------------------
-- 12. Every foreign key is indexed
-- ---------------------------------------------------------------------------
-- Postgres does not index the referencing side automatically, and the omission
-- shows up later as slow deletes and lock contention.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s(%s)', c.conrelid::regclass, a.attname), ', ')
    INTO missing
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.contype = 'f'
    AND c.connamespace = 'public'::regnamespace
    AND array_length(c.conkey, 1) = 1
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND i.indkey[0] = k.attnum
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: unindexed foreign keys: %', missing;
  END IF;
  RAISE NOTICE 'ok 12 every foreign key is indexed';
END $$;

-- ---------------------------------------------------------------------------
-- 13. Row-level security is enabled on every user-owned table
-- ---------------------------------------------------------------------------
DO $$
DECLARE unguarded text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO unguarded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND a.attnum > 0 AND NOT a.attisdropped
    );
  IF unguarded IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: tables with user_id and no row-level security: %', unguarded;
  END IF;
  RAISE NOTICE 'ok 13 row-level security enabled on every user-owned table';
END $$;

-- ---------------------------------------------------------------------------
-- 14. The application role cannot read credentials
-- ---------------------------------------------------------------------------
DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(t, ', ') INTO leaked
  FROM unnest(ARRAY['auth_sessions', 'password_reset_tokens', 'email_verification_tokens']) AS t
  WHERE has_table_privilege('daybook_app', t, 'SELECT');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: daybook_app can read credential tables: %', leaked;
  END IF;
  RAISE NOTICE 'ok 14 application role has no access to credential tables';
END $$;

-- ---------------------------------------------------------------------------
-- 15. Tenant isolation actually isolates
-- ---------------------------------------------------------------------------
-- The previous checks confirm the policies exist. This one confirms they work,
-- by querying as the unprivileged application role rather than as the owner,
-- who bypasses row-level security.
GRANT SELECT ON activities, users TO daybook_app;
SET ROLE daybook_app;
-- Session scope, not SET LOCAL: psql runs each statement in its own implicit
-- transaction, so a LOCAL setting would be discarded before the next one.
SELECT set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);

DO $$
DECLARE mine int; theirs int;
BEGIN
  SELECT count(*) INTO mine FROM activities;
  IF mine = 0 THEN
    RAISE EXCEPTION 'FAIL: the owner of the rows cannot see their own activities';
  END IF;

  PERFORM set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT count(*) INTO theirs FROM activities;
  IF theirs <> 0 THEN
    RAISE EXCEPTION 'FAIL: another account could see % activities', theirs;
  END IF;

  PERFORM set_config('app.current_user_id', '', false);
  SELECT count(*) INTO theirs FROM activities;
  IF theirs <> 0 THEN
    RAISE EXCEPTION 'FAIL: an unauthenticated connection could see % activities', theirs;
  END IF;

  RAISE NOTICE 'ok 15 tenant isolation holds for another user and for no user';
END $$;

RESET ROLE;
