-- Daybook initial schema.
-- Derived from docs/DATABASE.md. Status values are text with CHECK constraints
-- rather than Postgres enums: adding a value to an enum is a migration that
-- cannot run inside a transaction on older servers, and dropping one is not
-- supported at all. A CHECK constraint is edited freely.

BEGIN;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- updated_at is maintained by a trigger rather than by application code, so
-- raw SQL, background jobs and migrations cannot bypass it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A bad IANA zone is silent, permanent corruption: every occurrence built from
-- it lands at the wrong instant. It cannot be a CHECK constraint because that
-- would need a subquery against pg_timezone_names, so it is a trigger.
CREATE OR REPLACE FUNCTION validate_timezone() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'invalid IANA timezone: %', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One definition of "who is asking", used by every policy. nullif() matters:
-- a session variable set to the empty string would otherwise raise a cast error
-- and surface as a 500 instead of an empty result.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

-- Every user-scoped table gets the same policy. Written once, applied by name.
CREATE OR REPLACE FUNCTION apply_user_rls(target regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s '
    'USING (user_id = current_app_user_id()) '
    'WITH CHECK (user_id = current_app_user_id())',
    target);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL,
  password_hash      text,
  email_verified_at  timestamptz,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'pending_deletion')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name         text,
  avatar_url           text,
  timezone             text NOT NULL DEFAULT 'Europe/London',
  locale               text NOT NULL DEFAULT 'en-GB',
  week_start_day       smallint NOT NULL DEFAULT 1 CHECK (week_start_day BETWEEN 1 AND 7),
  preferred_wake_time  time,
  preferred_sleep_time time,
  sleep_target_minutes int CHECK (sleep_target_minutes IS NULL OR sleep_target_minutes > 0),
  weight_unit          text NOT NULL DEFAULT 'kg' CHECK (weight_unit IN ('kg', 'lb')),
  distance_unit        text NOT NULL DEFAULT 'km' CHECK (distance_unit IN ('km', 'mi')),
  theme                text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  default_workout_days smallint[] NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION validate_timezone();
CREATE TRIGGER user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_preferences (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score_weights          jsonb NOT NULL DEFAULT
                           '{"schedule":0.35,"habits":0.25,"workout":0.20,"timeliness":0.20}'::jsonb,
  analytics_start_of_day time NOT NULL DEFAULT '04:00',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_preferences (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activity_reminders    boolean NOT NULL DEFAULT true,
  activity_lead_minutes int NOT NULL DEFAULT 10 CHECK (activity_lead_minutes BETWEEN 0 AND 240),
  habit_reminders       boolean NOT NULL DEFAULT true,
  habit_reminder_time   time,
  workout_reminders     boolean NOT NULL DEFAULT true,
  wake_reminder         boolean NOT NULL DEFAULT false,
  sleep_reminder        boolean NOT NULL DEFAULT false,
  quiet_hours_start     time,
  quiet_hours_end       time,
  channels              text[] NOT NULL DEFAULT '{push}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id           uuid NOT NULL,
  refresh_token_hash  bytea NOT NULL UNIQUE,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  rotated_at          timestamptz,
  replaced_by         uuid REFERENCES auth_sessions(id) ON DELETE SET NULL,
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IS NULL OR revoked_reason IN
                        ('logout', 'logout_all', 'rotation', 'reuse_detected',
                         'password_change', 'account_deleted')),
  client              text NOT NULL CHECK (client IN ('daybook', 'fitness')),
  user_agent_hash     bytea,
  ip_hash             bytea,
  CONSTRAINT auth_sessions_expiry_after_issue CHECK (expires_at > issued_at)
);
CREATE INDEX auth_sessions_user_expiry_idx ON auth_sessions (user_id, expires_at);
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
-- The reuse-detection lookup: a token presented after rotation.
CREATE INDEX auth_sessions_live_idx ON auth_sessions (user_id)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;
CREATE INDEX auth_sessions_replaced_by_idx ON auth_sessions (replaced_by);

CREATE TABLE auth_identities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_account_id text NOT NULL,
  email_at_provider   citext,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz,
  UNIQUE (provider, provider_account_id)
);
CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Daybook
-- ---------------------------------------------------------------------------

CREATE TABLE activity_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text NOT NULL,
  icon       text,
  is_system  boolean NOT NULL DEFAULT false,
  is_fitness boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT activity_categories_system_has_no_owner
    CHECK ((is_system AND user_id IS NULL) OR (NOT is_system AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX activity_categories_user_name_key
  ON activity_categories (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX activity_categories_system_name_key
  ON activity_categories (lower(name)) WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE TRIGGER activity_categories_updated_at BEFORE UPDATE ON activity_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE activity_series (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  description           text,
  category_id           uuid REFERENCES activity_categories(id) ON DELETE SET NULL,
  priority              smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  rrule                 text NOT NULL,
  timezone              text NOT NULL,
  start_date            date NOT NULL,
  end_date              date,
  start_time            time NOT NULL,
  duration_minutes      int NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  reminder_lead_minutes int CHECK (reminder_lead_minutes IS NULL OR reminder_lead_minutes BETWEEN 0 AND 1440),
  is_active             boolean NOT NULL DEFAULT true,
  materialised_through  date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT activity_series_dates_ordered CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX activity_series_user_active_idx ON activity_series (user_id, is_active)
  WHERE deleted_at IS NULL;
-- The materialiser's queue: active series whose horizon needs extending.
CREATE INDEX activity_series_horizon_idx ON activity_series (materialised_through)
  WHERE is_active AND deleted_at IS NULL;
CREATE INDEX activity_series_category_idx ON activity_series (category_id);
CREATE TRIGGER activity_series_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON activity_series
  FOR EACH ROW EXECUTE FUNCTION validate_timezone();
CREATE TRIGGER activity_series_updated_at BEFORE UPDATE ON activity_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE series_exceptions (
  series_id       uuid NOT NULL REFERENCES activity_series(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('cancelled', 'detached')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, occurrence_date)
);
CREATE INDEX series_exceptions_user_idx ON series_exceptions (user_id);

CREATE TABLE activities (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id                uuid REFERENCES activity_series(id) ON DELETE SET NULL,
  occurrence_date          date NOT NULL,
  title                    text NOT NULL,
  description              text,
  category_id              uuid REFERENCES activity_categories(id) ON DELETE SET NULL,
  priority                 smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  planned_start            timestamptz NOT NULL,
  planned_end              timestamptz NOT NULL,
  planned_duration_minutes int GENERATED ALWAYS AS
                             ((EXTRACT(EPOCH FROM (planned_end - planned_start)) / 60)::int) STORED,
  status                   text NOT NULL DEFAULT 'planned'
                             CHECK (status IN ('planned', 'active', 'completed', 'partial',
                                               'skipped', 'missed', 'rescheduled')),
  completion_ratio         numeric(3,2) CHECK (completion_ratio IS NULL OR
                                               (completion_ratio >= 0 AND completion_ratio <= 1)),
  actual_start             timestamptz,
  actual_end               timestamptz,
  actual_duration_minutes  int CHECK (actual_duration_minutes IS NULL OR actual_duration_minutes >= 0),
  start_deviation_minutes  int GENERATED ALWAYS AS
                             ((EXTRACT(EPOCH FROM (actual_start - planned_start)) / 60)::int) STORED,
  notes                    text,
  source                   text NOT NULL DEFAULT 'manual'
                             CHECK (source IN ('manual', 'series', 'sync')),
  is_detached              boolean NOT NULL DEFAULT false,
  manually_overridden      boolean NOT NULL DEFAULT false,
  sync_issue               boolean NOT NULL DEFAULT false,
  workout_session_id       uuid,
  origin_event_id          uuid,
  last_synced_event_at     timestamptz,
  reminder_sent_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT activities_planned_window CHECK (planned_end > planned_start),
  CONSTRAINT activities_actual_window CHECK (actual_end IS NULL OR actual_start IS NULL
                                             OR actual_end >= actual_start),
  -- A row can only claim a series occurrence if it has a series.
  CONSTRAINT activities_series_source CHECK (series_id IS NOT NULL OR source <> 'series')
);
-- The timeline query: everything for one user on one day.
CREATE INDEX activities_user_date_idx ON activities (user_id, occurrence_date)
  WHERE deleted_at IS NULL;
-- One materialised row per series occurrence, ever.
CREATE UNIQUE INDEX activities_series_occurrence_key
  ON activities (series_id, occurrence_date) WHERE series_id IS NOT NULL AND deleted_at IS NULL;
-- One activity per sync event, ever. This is guard 4 of the sync design.
CREATE UNIQUE INDEX activities_origin_event_key
  ON activities (origin_event_id) WHERE origin_event_id IS NOT NULL;
CREATE INDEX activities_user_status_date_idx ON activities (user_id, status, occurrence_date);
-- The reminder scheduler and the missed-activity sweeper.
CREATE INDEX activities_pending_idx ON activities (planned_start)
  WHERE status IN ('planned', 'active') AND deleted_at IS NULL;
CREATE INDEX activities_category_idx ON activities (category_id);
CREATE INDEX activities_series_idx ON activities (series_id);
CREATE TRIGGER activities_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE activity_status_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'sync', 'system')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX activity_status_events_activity_idx ON activity_status_events (activity_id, at);
CREATE INDEX activity_status_events_user_at_idx ON activity_status_events (user_id, at);

CREATE TABLE habits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  category_id     uuid REFERENCES activity_categories(id) ON DELETE SET NULL,
  target_type     text NOT NULL DEFAULT 'binary'
                    CHECK (target_type IN ('binary', 'count', 'duration')),
  target_value    numeric(10,2) CHECK (target_value IS NULL OR target_value > 0),
  unit            text,
  schedule_rrule  text,
  timezone        text NOT NULL,
  reminder_time   time,
  sort_order      int NOT NULL DEFAULT 0,
  is_archived     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT habits_target_present
    CHECK (target_type = 'binary' OR target_value IS NOT NULL)
);
CREATE INDEX habits_user_active_idx ON habits (user_id)
  WHERE NOT is_archived AND deleted_at IS NULL;
CREATE INDEX habits_category_idx ON habits (category_id);
CREATE TRIGGER habits_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON habits
  FOR EACH ROW EXECUTE FUNCTION validate_timezone();
CREATE TRIGGER habits_updated_at BEFORE UPDATE ON habits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE habit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id   uuid NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date   date NOT NULL,
  value      numeric(10,2),
  completed  boolean NOT NULL,
  source     text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'sync', 'system')),
  note       text,
  logged_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, log_date)
);
CREATE INDEX habit_logs_user_date_idx ON habit_logs (user_id, log_date);

CREATE TABLE journal_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  body       text,
  highlights text[] NOT NULL DEFAULT '{}',
  lessons    text,
  tags       text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX journal_entries_user_date_key
  ON journal_entries (user_id, entry_date) WHERE deleted_at IS NULL;
CREATE TRIGGER journal_entries_updated_at BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A cache, never a source of truth. Rebuildable from activities, habit_logs
-- and domain_events at any time.
CREATE TABLE daily_summaries (
  user_id                        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_date                   date NOT NULL,
  planned_count                  int NOT NULL DEFAULT 0,
  completed_count                int NOT NULL DEFAULT 0,
  partial_count                  int NOT NULL DEFAULT 0,
  skipped_count                  int NOT NULL DEFAULT 0,
  missed_count                   int NOT NULL DEFAULT 0,
  completion_pct                 numeric(5,2),
  productive_minutes             int NOT NULL DEFAULT 0,
  habits_due                     int NOT NULL DEFAULT 0,
  habits_completed               int NOT NULL DEFAULT 0,
  workout_planned                boolean NOT NULL DEFAULT false,
  workout_completed              boolean NOT NULL DEFAULT false,
  workout_minutes                int NOT NULL DEFAULT 0,
  median_start_deviation_minutes int,
  -- Null, not zero: a day with no plan is not a failed day.
  productivity_score             numeric(5,2)
                                   CHECK (productivity_score IS NULL OR
                                          (productivity_score >= 0 AND productivity_score <= 100)),
  score_breakdown                jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, summary_date)
);

-- ---------------------------------------------------------------------------
-- Fitness
-- ---------------------------------------------------------------------------

CREATE TABLE exercises (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  modality          text NOT NULL DEFAULT 'strength'
                      CHECK (modality IN ('strength', 'cardio', 'bodyweight', 'mobility')),
  primary_muscle    text,
  secondary_muscles text[] NOT NULL DEFAULT '{}',
  equipment         text,
  instructions      text,
  is_system         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT exercises_system_has_no_owner
    CHECK ((is_system AND user_id IS NULL) OR (NOT is_system AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX exercises_user_name_key
  ON exercises (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX exercises_system_name_key
  ON exercises (lower(name)) WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE INDEX exercises_modality_idx ON exercises (modality) WHERE deleted_at IS NULL;
CREATE TRIGGER exercises_updated_at BEFORE UPDATE ON exercises
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE routines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  notes             text,
  estimated_minutes int CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  is_archived       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX routines_user_idx ON routines (user_id)
  WHERE NOT is_archived AND deleted_at IS NULL;
CREATE TRIGGER routines_updated_at BEFORE UPDATE ON routines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE routine_exercises (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id              uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id             uuid NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  position                int NOT NULL CHECK (position >= 0),
  target_sets             int CHECK (target_sets IS NULL OR target_sets > 0),
  target_reps             int CHECK (target_reps IS NULL OR target_reps > 0),
  -- Weight is stored in kilograms, always. Display units are a profile setting.
  target_weight_kg        numeric(6,2) CHECK (target_weight_kg IS NULL OR target_weight_kg >= 0),
  target_duration_seconds int CHECK (target_duration_seconds IS NULL OR target_duration_seconds > 0),
  target_distance_m       int CHECK (target_distance_m IS NULL OR target_distance_m > 0),
  rest_seconds            int CHECK (rest_seconds IS NULL OR rest_seconds >= 0),
  superset_group          smallint,
  notes                   text,
  UNIQUE (routine_id, position)
);
CREATE INDEX routine_exercises_exercise_idx ON routine_exercises (exercise_id);
CREATE INDEX routine_exercises_user_idx ON routine_exercises (user_id);

CREATE TABLE workout_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id          uuid REFERENCES routines(id) ON DELETE SET NULL,
  activity_id         uuid REFERENCES activities(id) ON DELETE SET NULL,
  -- Generated by the client before the request is sent, so a workout logged
  -- offline and replayed twice resolves to one row.
  client_session_uuid uuid,
  name                text,
  status              text NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  duration_seconds    int CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  total_sets          int NOT NULL DEFAULT 0,
  total_reps          int NOT NULL DEFAULT 0,
  total_volume_kg     numeric(10,2) NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT workout_sessions_window CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT workout_sessions_completed_has_end
    CHECK (status <> 'completed' OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX workout_sessions_client_uuid_key
  ON workout_sessions (user_id, client_session_uuid) WHERE client_session_uuid IS NOT NULL;
CREATE INDEX workout_sessions_user_started_idx ON workout_sessions (user_id, started_at DESC);
CREATE UNIQUE INDEX workout_sessions_one_active_idx ON workout_sessions (user_id)
  WHERE status = 'in_progress' AND deleted_at IS NULL;
CREATE INDEX workout_sessions_activity_idx ON workout_sessions (activity_id);
CREATE INDEX workout_sessions_routine_idx ON workout_sessions (routine_id);
CREATE TRIGGER workout_sessions_updated_at BEFORE UPDATE ON workout_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE session_exercises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  position    int NOT NULL CHECK (position >= 0),
  notes       text,
  UNIQUE (session_id, position)
);
CREATE INDEX session_exercises_exercise_idx ON session_exercises (exercise_id);
CREATE INDEX session_exercises_user_idx ON session_exercises (user_id);

CREATE TABLE workout_sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_exercise_id uuid NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_number          int NOT NULL CHECK (set_number > 0),
  set_type            text NOT NULL DEFAULT 'working'
                        CHECK (set_type IN ('working', 'warmup', 'drop', 'failure')),
  reps                int CHECK (reps IS NULL OR reps >= 0),
  weight_kg           numeric(6,2) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  duration_seconds    int CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  distance_m          int CHECK (distance_m IS NULL OR distance_m >= 0),
  rpe                 numeric(3,1) CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10)),
  rest_seconds        int CHECK (rest_seconds IS NULL OR rest_seconds >= 0),
  completed           boolean NOT NULL DEFAULT false,
  performed_at        timestamptz,
  client_set_uuid     uuid,
  UNIQUE (session_exercise_id, set_number)
);
CREATE UNIQUE INDEX workout_sets_client_uuid_key
  ON workout_sets (user_id, client_set_uuid) WHERE client_set_uuid IS NOT NULL;
CREATE INDEX workout_sets_user_idx ON workout_sets (user_id);

-- Appended, never updated, so personal-record history is a real timeline.
CREATE TABLE personal_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id    uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  metric         text NOT NULL CHECK (metric IN ('max_weight', 'est_1rm', 'max_reps',
                                                 'max_volume_session', 'best_time', 'best_distance')),
  value          numeric(10,2) NOT NULL,
  unit           text NOT NULL,
  previous_value numeric(10,2),
  achieved_at    timestamptz NOT NULL DEFAULT now(),
  workout_set_id uuid REFERENCES workout_sets(id) ON DELETE SET NULL,
  session_id     uuid REFERENCES workout_sessions(id) ON DELETE SET NULL
);
CREATE INDEX personal_records_lookup_idx
  ON personal_records (user_id, exercise_id, metric, achieved_at DESC);
-- The composite above leads with user_id, so it does not serve deletes that
-- cascade from an exercise, a set or a session. Those need their own.
CREATE INDEX personal_records_exercise_idx ON personal_records (exercise_id);
CREATE INDEX personal_records_set_idx ON personal_records (workout_set_id);
CREATE INDEX personal_records_session_idx ON personal_records (session_id);

-- ---------------------------------------------------------------------------
-- Integration: outbox, delivery, sync, notifications
-- ---------------------------------------------------------------------------

-- The transactional outbox. Rows are written in the same COMMIT as the change
-- that caused them, which is what makes an event impossible to lose.
CREATE TABLE domain_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  schema_version  smallint NOT NULL DEFAULT 1,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE,
  source_app      text NOT NULL CHECK (source_app IN ('daybook', 'fitness', 'system'))
);
CREATE INDEX domain_events_user_time_idx ON domain_events (user_id, occurred_at DESC);
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id);
CREATE INDEX domain_events_type_idx ON domain_events (event_type, occurred_at DESC);

-- Composite primary key is the delivery guarantee: one event, one consumer, once.
CREATE TABLE event_deliveries (
  event_id        uuid NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  consumer        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  processed_at    timestamptz,
  PRIMARY KEY (event_id, consumer)
);
-- The dispatcher's only query.
CREATE INDEX event_deliveries_queue_idx ON event_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');
-- Finds handlers that died mid-flight, for the reclaim sweep.
CREATE INDEX event_deliveries_stuck_idx ON event_deliveries (claimed_at)
  WHERE status = 'processing';

CREATE TABLE sync_mutations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_mutation_id uuid NOT NULL,
  entity             text NOT NULL,
  operation          text NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'applied', 'duplicate', 'conflict', 'rejected')),
  result             jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  applied_at         timestamptz,
  UNIQUE (user_id, client_mutation_id)
);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,
  title         text NOT NULL,
  body          text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel       text NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'email', 'in_app')),
  scheduled_for timestamptz NOT NULL,
  sent_at       timestamptz,
  read_at       timestamptz,
  dismissed_at  timestamptz,
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_key
  ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_due_idx ON notifications (scheduled_for) WHERE sent_at IS NULL;
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  client       text NOT NULL CHECK (client IN ('daybook', 'fitness')),
  failed_count int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE data_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format       text NOT NULL CHECK (format IN ('json', 'csv')),
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  object_key   text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz
);
CREATE INDEX data_exports_user_idx ON data_exports (user_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Circular references, added once both sides exist
-- ---------------------------------------------------------------------------

ALTER TABLE activities
  ADD CONSTRAINT activities_workout_session_fkey
  FOREIGN KEY (workout_session_id) REFERENCES workout_sessions(id) ON DELETE SET NULL;

ALTER TABLE activities
  ADD CONSTRAINT activities_origin_event_fkey
  FOREIGN KEY (origin_event_id) REFERENCES domain_events(id) ON DELETE SET NULL;

CREATE INDEX activities_workout_session_idx ON activities (workout_session_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Application code checks ownership on every query. These policies exist so
-- that a missing WHERE clause returns zero rows instead of another account's data.

SELECT apply_user_rls('user_profiles');
SELECT apply_user_rls('user_preferences');
SELECT apply_user_rls('notification_preferences');
SELECT apply_user_rls('auth_identities');
SELECT apply_user_rls('activity_series');
SELECT apply_user_rls('series_exceptions');
SELECT apply_user_rls('activities');
SELECT apply_user_rls('activity_status_events');
SELECT apply_user_rls('habits');
SELECT apply_user_rls('habit_logs');
SELECT apply_user_rls('journal_entries');
SELECT apply_user_rls('daily_summaries');
SELECT apply_user_rls('routines');
SELECT apply_user_rls('routine_exercises');
SELECT apply_user_rls('workout_sessions');
SELECT apply_user_rls('session_exercises');
SELECT apply_user_rls('workout_sets');
SELECT apply_user_rls('personal_records');
SELECT apply_user_rls('domain_events');
SELECT apply_user_rls('sync_mutations');
SELECT apply_user_rls('notifications');
SELECT apply_user_rls('push_subscriptions');
SELECT apply_user_rls('data_exports');

-- users has no user_id column: the policy compares the primary key instead.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (id = current_app_user_id())
  WITH CHECK (id = current_app_user_id());

-- Categories and exercises are readable when they are the shared system rows,
-- and writable only when they belong to the caller.
ALTER TABLE activity_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON activity_categories FOR SELECT
  USING (user_id IS NULL OR user_id = current_app_user_id());
CREATE POLICY tenant_write ON activity_categories FOR ALL
  USING (user_id = current_app_user_id())
  WITH CHECK (user_id = current_app_user_id());

ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON exercises FOR SELECT
  USING (user_id IS NULL OR user_id = current_app_user_id());
CREATE POLICY tenant_write ON exercises FOR ALL
  USING (user_id = current_app_user_id())
  WITH CHECK (user_id = current_app_user_id());

-- event_deliveries has no user_id: it is reached only by the worker, which
-- runs outside a user context. It is protected by grants, not by RLS.

-- ---------------------------------------------------------------------------
-- Credential tables: a separate role, not a weakened policy
-- ---------------------------------------------------------------------------
-- These three are read before a user context exists, so "user_id = the current
-- user" cannot be the rule. Instead they are walled off by role: only
-- daybook_auth can touch them, and daybook_app cannot see them at all.

REVOKE ALL ON auth_sessions, password_reset_tokens, email_verification_tokens
  FROM daybook_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth_sessions, password_reset_tokens, email_verification_tokens, users, auth_identities
  TO daybook_auth;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_service ON auth_sessions TO daybook_auth USING (true) WITH CHECK (true);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_service ON password_reset_tokens TO daybook_auth USING (true) WITH CHECK (true);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_service ON email_verification_tokens TO daybook_auth USING (true) WITH CHECK (true);

-- The auth service also needs to find a user by email before anyone is logged in.
CREATE POLICY auth_service ON users TO daybook_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_service ON auth_identities TO daybook_auth USING (true) WITH CHECK (true);

COMMIT;
