-- Schema smoke tests. Every block raises on failure, so a clean run means
-- every assertion held. Run against a freshly migrated database:
--   psql -v ON_ERROR_STOP=1 -d daybook_dev -f packages/db/tests/schema_smoke.sql
--
-- Or, with no psql installed, through the Prisma CLI:
--   pnpm --filter @daybook/db db:smoke
--
-- Deliberately free of psql backslash directives so both paths work. Every
-- assertion raises on failure, so a clean exit means they all held; psql also
-- prints an "ok N" notice per assertion, which Prisma does not surface.

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Cleared first and again at the end, so the file can be run repeatedly
-- against the same database and leaves nothing behind. A test suite that only
-- works on a virgin database is a test suite people stop running.

-- Cleared by id as well as by email. Every fixture below uses a fixed id, so a
-- run that stops partway leaves rows behind, and deleting only by email misses
-- the ones whose table has no email. That turns a single failure into every
-- later run failing on a primary key, which hides whatever the real problem
-- was. Order matters: children before parents.
DELETE FROM activities WHERE id = '77777777-7777-7777-7777-777777777777';
DELETE FROM activity_categories WHERE id = '88888888-8888-8888-8888-888888888888';
DELETE FROM users
 WHERE email IN ('ada@example.com', 'grace@example.com')
    OR id IN ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');

INSERT INTO users (id, email, password_hash)
VALUES ('11111111-1111-1111-1111-111111111111', 'ada@example.com', 'argon2-placeholder'),
       ('22222222-2222-2222-2222-222222222222', 'grace@example.com', 'argon2-placeholder');

-- Updated, not inserted: migration 0003 gives every new user their profile row
-- in the same transaction as the user. Assertion 16 checks that it did.
UPDATE user_profiles SET display_name = 'Ada', timezone = 'Africa/Lagos'
 WHERE user_id = '11111111-1111-1111-1111-111111111111';
UPDATE user_profiles SET display_name = 'Grace', timezone = 'Europe/London'
 WHERE user_id = '22222222-2222-2222-2222-222222222222';

-- The fitness category is no longer invented here. Migration 0004 seeds the
-- eight system categories, and a second system row called Fitness now collides
-- with the partial unique index over lower(name). The fixture reads the seeded
-- row instead, which is also what the application will do.
CREATE OR REPLACE FUNCTION smoke_fitness_category() RETURNS uuid AS $$
  SELECT id FROM activity_categories
   WHERE user_id IS NULL AND is_fitness AND deleted_at IS NULL
   LIMIT 1
$$ LANGUAGE sql STABLE;

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
        DATE '2026-08-28', 'Gym', smoke_fitness_category(),
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
-- who bypasses row-level security. It relies on the grants from migration 0002
-- rather than granting anything itself: a test that alters permissions can
-- leave the system less secure than it found it.
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

-- ---------------------------------------------------------------------------
-- 16. Creating a user creates its companion rows, atomically
-- ---------------------------------------------------------------------------
-- Both fixture users were inserted with a bare INSERT INTO users at the top of
-- this file. Nothing here created a profile, a preferences row or a
-- notification row, so if they exist the trigger from migration 0003 made them.
DO $$
DECLARE profiles int; prefs int; notifs int;
BEGIN
  SELECT count(*) INTO profiles FROM user_profiles
    WHERE user_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO prefs FROM user_preferences
    WHERE user_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO notifs FROM notification_preferences
    WHERE user_id = '11111111-1111-1111-1111-111111111111';
  IF profiles <> 1 OR prefs <> 1 OR notifs <> 1 THEN
    RAISE EXCEPTION 'FAIL: companion rows were %, %, %, expected 1 each',
      profiles, prefs, notifs;
  END IF;
  RAISE NOTICE 'ok 16 a new user gets profile, preferences and notification rows';
END $$;

-- ---------------------------------------------------------------------------
-- 17. The auth role holds credentials and nothing more
-- ---------------------------------------------------------------------------
-- Assertion 14 checks the wall from the application side. This checks it from
-- the other side: daybook_auth exists to read and write credentials, and the
-- reason migration 0003 uses a trigger rather than application code is so that
-- this role never needs to reach a profile table. If that ever changes by
-- accident, this fails.
DO $$
DECLARE overreach text;
BEGIN
  SELECT string_agg(t, ', ') INTO overreach
  FROM unnest(ARRAY['user_profiles', 'user_preferences', 'notification_preferences',
                    'activities', 'workout_sessions', 'habits', 'journal_entries']) AS t
  WHERE has_table_privilege('daybook_auth', t, 'SELECT');
  IF overreach IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: daybook_auth can read non-credential tables: %', overreach;
  END IF;

  IF NOT has_table_privilege('daybook_auth', 'auth_sessions', 'INSERT')
     OR NOT has_table_privilege('daybook_auth', 'users', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: daybook_auth cannot do its own job';
  END IF;
  RAISE NOTICE 'ok 17 auth role reaches credentials and users, nothing else';
END $$;

-- ---------------------------------------------------------------------------
-- 18. A refresh token hash is unique, and dead sessions can be pruned
-- ---------------------------------------------------------------------------
INSERT INTO auth_sessions (id, user_id, family_id, refresh_token_hash, expires_at, client)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        digest('live-token', 'sha256'), now() + interval '30 days', 'daybook');

DO $$
DECLARE pruned int; survivors int;
BEGIN
  BEGIN
    INSERT INTO auth_sessions (user_id, family_id, refresh_token_hash, expires_at, client)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'cccccccc-cccc-cccc-cccc-cccccccccccc',
            digest('live-token', 'sha256'), now() + interval '30 days', 'fitness');
    RAISE EXCEPTION 'FAIL: two sessions accepted the same refresh token hash';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- An expired session from well beyond the retention window, plus the live one.
  INSERT INTO auth_sessions (user_id, family_id, refresh_token_hash, issued_at,
                             expires_at, client)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'dddddddd-dddd-dddd-dddd-dddddddddddd',
          digest('stale-token', 'sha256'), now() - interval '200 days',
          now() - interval '170 days', 'daybook');

  SELECT prune_auth_sessions() INTO pruned;
  IF pruned < 1 THEN
    RAISE EXCEPTION 'FAIL: prune_auth_sessions removed % rows, expected at least 1', pruned;
  END IF;

  SELECT count(*) INTO survivors FROM auth_sessions
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  IF survivors <> 1 THEN
    RAISE EXCEPTION 'FAIL: pruning deleted a live session';
  END IF;
  RAISE NOTICE 'ok 18 refresh hashes are unique and dead sessions prune cleanly';
END $$;

-- ---------------------------------------------------------------------------
-- 19. The system categories exist, are shared, and exactly one is the fitness
--     one. SYNC.md rules 2 and 3 select on is_fitness and say "if exactly one,
--     that is the match", which stops meaning anything if two rows claim it.
--     Seeded by migration 0004; before that every account had an empty picker
--     and rule 2 could never fire.
-- ---------------------------------------------------------------------------
DO $$
DECLARE seeded int; fitness int; owned int;
BEGIN
  SELECT count(*) INTO seeded
    FROM activity_categories WHERE user_id IS NULL AND deleted_at IS NULL;
  IF seeded < 8 THEN
    RAISE EXCEPTION 'FAIL: expected at least 8 system categories, found %', seeded;
  END IF;

  SELECT count(*) INTO fitness
    FROM activity_categories
   WHERE user_id IS NULL AND is_fitness AND deleted_at IS NULL;
  IF fitness <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one system fitness category, found %', fitness;
  END IF;

  -- is_system and a null owner move together, or a user could own a row that
  -- every other user can read.
  SELECT count(*) INTO owned
    FROM activity_categories WHERE user_id IS NULL AND NOT is_system;
  IF owned <> 0 THEN
    RAISE EXCEPTION 'FAIL: % shared categories are not marked is_system', owned;
  END IF;
  RAISE NOTICE 'ok 19 system categories are seeded and exactly one is fitness';
END $$;

-- ---------------------------------------------------------------------------
-- 20. An activity can be paused, and cannot be given a status nobody defined.
--     The state machine in packages/domain can produce 'paused'; if the CHECK
--     constraint disagrees, the disagreement surfaces as a 500 on a write
--     rather than as a refusal.
-- ---------------------------------------------------------------------------
DO $$
DECLARE stored text;
BEGIN
  INSERT INTO activities (id, user_id, occurrence_date, title, priority,
                          planned_start, planned_end, status)
  VALUES ('77777777-7777-7777-7777-777777777777',
          '11111111-1111-1111-1111-111111111111',
          DATE '2026-09-07', 'Gym', 3,
          TIMESTAMPTZ '2026-09-07 18:00+01', TIMESTAMPTZ '2026-09-07 19:30+01',
          'paused');

  SELECT status INTO stored FROM activities
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF stored <> 'paused' THEN
    RAISE EXCEPTION 'FAIL: stored status was %, expected paused', stored;
  END IF;

  BEGIN
    UPDATE activities SET status = 'procrastinating'
     WHERE id = '77777777-7777-7777-7777-777777777777';
    RAISE EXCEPTION 'FAIL: the status constraint accepted an undefined status';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'ok 20 paused is a legal status and nonsense is still rejected';
END $$;

-- ---------------------------------------------------------------------------
-- 21. Deleting a category leaves its activities alone rather than cascading.
--     API.md calls this "reassigns to Uncategorised"; uncategorised is null,
--     and losing the day's plan because a colour was tidied up would be the
--     worst possible reading of that sentence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE survivors int; still_linked uuid;
BEGIN
  INSERT INTO activity_categories (id, user_id, name, color)
  VALUES ('88888888-8888-8888-8888-888888888888',
          '11111111-1111-1111-1111-111111111111', 'Doomed', '#000000');

  UPDATE activities SET category_id = '88888888-8888-8888-8888-888888888888'
   WHERE id = '77777777-7777-7777-7777-777777777777';

  DELETE FROM activity_categories WHERE id = '88888888-8888-8888-8888-888888888888';

  SELECT count(*) INTO survivors FROM activities
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF survivors <> 1 THEN
    RAISE EXCEPTION 'FAIL: deleting a category deleted its activities';
  END IF;

  SELECT category_id INTO still_linked FROM activities
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF still_linked IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: activity still points at a deleted category';
  END IF;
  RAISE NOTICE 'ok 21 deleting a category clears the link and keeps the activity';
END $$;

-- ---------------------------------------------------------------------------
-- Leave nothing behind
-- ---------------------------------------------------------------------------
DELETE FROM activities WHERE id = '77777777-7777-7777-7777-777777777777';
DELETE FROM activity_categories WHERE id = '88888888-8888-8888-8888-888888888888';
DELETE FROM users
 WHERE email IN ('ada@example.com', 'grace@example.com')
    OR id IN ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
DROP FUNCTION IF EXISTS smoke_fitness_category();
