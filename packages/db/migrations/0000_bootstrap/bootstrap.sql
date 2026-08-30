-- Bootstrap: extensions and roles.
-- Run once per database, before the first migration. Requires a superuser or
-- a role with CREATEROLE. Roles are cluster-wide, which is why this is not a
-- normal migration.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The application connects as daybook_app, which is deliberately NOT the owner
-- of any table. Row-level security is bypassed by table owners unless FORCE is
-- set, and relying on FORCE alone is one config drift away from a data leak.
-- A separate, non-owning role means RLS applies by default rather than by
-- remembering to force it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daybook_app') THEN
    CREATE ROLE daybook_app LOGIN;
  END IF;
  -- Authentication runs before any user context exists: a login looks a row up
  -- by email, a refresh looks one up by token hash, and neither can be filtered
  -- by "the current user". Those tables therefore get their own role rather
  -- than a weakened policy, and daybook_app is given no access to them at all,
  -- so a bug in application code cannot read a password hash or a refresh token.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daybook_auth') THEN
    CREATE ROLE daybook_auth LOGIN;
  END IF;
END
$$;

-- The migrating role needs membership in both roles to SET ROLE into them,
-- which the schema tests do when they check tenant isolation as the
-- unprivileged role. A superuser can SET ROLE freely; a managed provider's
-- owner role cannot, so the grant has to be explicit.
DO $$
BEGIN
  EXECUTE format('GRANT daybook_app TO %I', current_user);
  EXECUTE format('GRANT daybook_auth TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'role membership not granted (%), SET ROLE tests will be skipped', SQLERRM;
END
$$;

-- Migrations run as the owner. The application role gets DML only: no DDL,
-- no ability to disable a policy.
GRANT USAGE ON SCHEMA public TO daybook_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daybook_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO daybook_app;
