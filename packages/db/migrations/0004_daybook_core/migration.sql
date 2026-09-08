-- Phase 4, the database half of the first vertical slice.
--
-- Two changes, both of them closing a gap between what the documentation
-- describes and what 0001_init actually built.
--
--   1. `paused` becomes a status. API.md has always defined
--      POST /activities/:id/pause and /resume, and DATABASE.md has always said
--      actual_duration_minutes accumulates across pauses, but the CHECK
--      constraint had nowhere for a paused activity to sit. Deriving "is the
--      clock running" from the status-event log was the alternative; a state
--      the user can see on screen is better represented as a column than
--      reconstructed on every read.
--
--   2. The eight system categories get seeded. They were specified in Phase 1
--      and never written, so every account has had an empty category picker,
--      and SYNC.md's rule 2 (match a workout to an overlapping fitness-category
--      activity) could never fire, because no row had is_fitness set. That
--      would not have surfaced until Phase 9, as duplicate activities rather
--      than as an error.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. paused
-- ---------------------------------------------------------------------------

-- The original constraint was written inline, so its name was chosen by
-- PostgreSQL. Dropping a guessed name with IF EXISTS would silently do nothing
-- if the guess were wrong, leaving the old constraint in place to reject
-- 'paused' later, and the migration would report success. So: find it, insist
-- there is exactly one, and fail loudly otherwise.
DO $$
DECLARE
  target text;
  found  int;
BEGIN
  SELECT count(*), min(conname)
    INTO found, target
    FROM pg_constraint
   WHERE conrelid = 'activities'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%''planned''%';

  IF found <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one status CHECK on activities, found %. Refusing to guess.', found;
  END IF;

  EXECUTE format('ALTER TABLE activities DROP CONSTRAINT %I', target);
END $$;

ALTER TABLE activities ADD CONSTRAINT activities_status_check
  CHECK (status IN ('planned', 'active', 'paused', 'completed', 'partial',
                    'skipped', 'missed', 'rescheduled'));

-- The reminder scheduler must not nag about an activity somebody has
-- deliberately paused, and the timeline must be able to find one cheaply.
DROP INDEX IF EXISTS activities_reminder_idx;
CREATE INDEX activities_reminder_idx
  ON activities (user_id, planned_start)
  WHERE status IN ('planned', 'active', 'paused') AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The system categories
-- ---------------------------------------------------------------------------

-- user_id IS NULL marks a shared row, which the RLS read policy on this table
-- already allows everyone to see and nobody to modify. is_system and a null
-- owner are tied together by activity_categories_system_has_no_owner, so these
-- two columns move together or the insert is rejected.
--
-- Keyed on lower(name) through the partial unique index 0001_init created for
-- exactly this purpose, so re-running the migration inserts nothing and
-- changes nothing. Seed data has to be safe to re-run; a seed that is not is
-- a seed that stops being applied.
INSERT INTO activity_categories (name, color, icon, is_system, is_fitness, sort_order)
VALUES
  ('Routine',  '#64748B', 'sunrise',   true, false, 10),
  ('Work',     '#2563EB', 'briefcase', true, false, 20),
  ('Study',    '#7C3AED', 'book',      true, false, 30),
  ('Fitness',  '#059669', 'dumbbell',  true, true,  40),
  ('Meals',    '#D97706', 'utensils',  true, false, 50),
  ('Rest',     '#0891B2', 'moon',      true, false, 60),
  ('Personal', '#DB2777', 'heart',     true, false, 70),
  ('Admin',    '#525252', 'folder',    true, false, 80)
ON CONFLICT (lower(name)) WHERE user_id IS NULL AND deleted_at IS NULL
DO NOTHING;

-- Exactly one system category is the fitness one. SYNC.md rules 2 and 3 select
-- on it, and "if exactly one, that is the match" stops meaning anything if two
-- rows claim it. Asserted here rather than trusted, because the cost of it
-- being wrong is silent duplicate activities in Phase 9.
DO $$
DECLARE fitness int;
BEGIN
  SELECT count(*) INTO fitness
    FROM activity_categories
   WHERE user_id IS NULL AND is_fitness AND deleted_at IS NULL;

  IF fitness <> 1 THEN
    RAISE EXCEPTION 'expected exactly one system fitness category, found %', fitness;
  END IF;
END $$;

COMMIT;
