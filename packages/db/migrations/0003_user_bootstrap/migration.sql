-- Every user gets their companion rows in the same transaction that creates
-- them, whatever created them.
--
-- Three tables hang off users one-to-one: user_profiles, user_preferences and
-- notification_preferences. Without this trigger, each code path that can
-- create a user has to remember to create all three: password registration,
-- Google sign-in in Phase 3b, a seed script, an admin repair, a manual INSERT
-- during an incident. Every one of those is a chance to forget, and the
-- symptom of forgetting shows up much later as a null profile in a query that
-- had no reason to expect one.
--
-- There is a second reason it has to be a trigger rather than application
-- code. Registration runs as daybook_auth, which by design cannot touch
-- user_profiles: that role exists to hold credentials and nothing else. The
-- alternatives were to widen daybook_auth until it could write profile tables,
-- or to insert the user and then create the profile in a second connection as
-- daybook_app, which is two transactions and therefore a window in which a
-- crash leaves a user with no profile. A SECURITY DEFINER trigger keeps the
-- role narrow and the write atomic.
--
-- SECURITY DEFINER means the body runs as the function's owner, so it sets
-- search_path explicitly. A SECURITY DEFINER function that inherits the
-- caller's search_path can be hijacked by a caller who creates a table of the
-- same name earlier in their path.

BEGIN;

CREATE OR REPLACE FUNCTION create_user_companion_rows() RETURNS trigger AS $$
BEGIN
  -- ON CONFLICT DO NOTHING so the function is safe if a code path ever does
  -- create these rows itself, and so a repair backfill can reuse it.
  INSERT INTO public.user_profiles (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_preferences (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  INSERT INTO public.notification_preferences (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- The function is powerful by construction, so nobody gets to call it directly.
-- As a trigger it can only ever run with a row the database itself supplied.
REVOKE ALL ON FUNCTION create_user_companion_rows() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_create_companion_rows ON users;
CREATE TRIGGER users_create_companion_rows AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION create_user_companion_rows();

-- Backfill anything that predates the trigger. On a fresh database this is a
-- no-op; on an existing one it is the repair.
INSERT INTO user_profiles (user_id) SELECT id FROM users ON CONFLICT DO NOTHING;
INSERT INTO user_preferences (user_id) SELECT id FROM users ON CONFLICT DO NOTHING;
INSERT INTO notification_preferences (user_id) SELECT id FROM users ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Session housekeeping
-- ---------------------------------------------------------------------------

-- Refresh rotation reads a session by its token hash on every single refresh,
-- which is the hottest auth query there is. The UNIQUE constraint on
-- refresh_token_hash already provides an index, so this is a comment rather
-- than an index: stated here so the next person does not add a duplicate.

-- Expired and revoked sessions are deleted rather than kept. They have no
-- analytical value, they are the most sensitive rows in the database, and the
-- reuse-detection check only ever looks at live and recently-rotated ones. The
-- worker calls this on a schedule from Phase 8; until then it is available to
-- run by hand.
CREATE OR REPLACE FUNCTION prune_auth_sessions(older_than interval DEFAULT interval '30 days')
  RETURNS integer AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM auth_sessions
   WHERE expires_at < now() - older_than
      OR (revoked_at IS NOT NULL AND revoked_at < now() - older_than);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;

-- Single-use tokens that were never used are worth nothing after they expire.
CREATE OR REPLACE FUNCTION prune_auth_tokens(older_than interval DEFAULT interval '7 days')
  RETURNS integer AS $$
DECLARE
  removed integer;
  total   integer := 0;
BEGIN
  DELETE FROM password_reset_tokens WHERE expires_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  total := total + removed;
  DELETE FROM email_verification_tokens WHERE expires_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN total + removed;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION prune_auth_sessions(interval) TO daybook_auth;
GRANT EXECUTE ON FUNCTION prune_auth_tokens(interval) TO daybook_auth;

COMMIT;
