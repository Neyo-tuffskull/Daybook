-- Restore and normalise the application role's privileges.
--
-- ALTER DEFAULT PRIVILEGES in the bootstrap only covers tables created after
-- it runs, which leaves grants vulnerable to drift: a table created outside
-- the normal flow, or a stray REVOKE, and the application loses access with no
-- sign of it until a query fails in production.
--
-- This migration states the intended grants outright and is safe to re-run at
-- any time, so it doubles as the repair when something has drifted.

BEGIN;

GRANT USAGE ON SCHEMA public TO daybook_app, daybook_auth;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO daybook_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daybook_app;

-- The credential tables stay walled off from the general application role,
-- exactly as migration 0001 set them. Re-stated here so that running this file
-- can never widen access as a side effect of repairing it.
REVOKE ALL ON auth_sessions, password_reset_tokens, email_verification_tokens
  FROM daybook_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth_sessions, password_reset_tokens, email_verification_tokens,
     users, auth_identities
  TO daybook_auth;

COMMIT;
