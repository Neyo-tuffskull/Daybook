/**
 * The database package's public surface.
 *
 * Three modules, split by who is allowed to run their queries:
 *
 *   clients  the two Prisma clients and `asUser`, the only place in the
 *            codebase permitted to call set_config
 *   auth     credential queries, which run as daybook_auth
 *   profile  profile queries, which run as the user under row-level security
 *
 * They live in separate files rather than one because the split is the security
 * boundary, and a boundary you can see is one people notice before crossing.
 */
export * from './clients.ts';
export * from './auth.ts';
export * from './profile.ts';
