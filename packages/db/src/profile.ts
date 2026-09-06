/**
 * Profile reads and writes, as the user themselves.
 *
 * Everything here goes through `asUser`, so the row-level security policies
 * decide what is visible rather than a WHERE clause the caller might forget.
 * The `WHERE user_id = ...` clauses below are belt and braces on top of the
 * policy, not the thing doing the work: remove them and the queries still
 * return only the caller's own row.
 */
import { asUser } from './clients.ts';
import type { Prisma } from './clients.ts';

export interface ProfileRow {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  timezone: string;
  locale: string;
  week_start_day: number;
  weight_unit: 'kg' | 'lb';
  distance_unit: 'km' | 'mi';
  theme: 'system' | 'light' | 'dark';
}

export function getProfile(userId: string): Promise<ProfileRow | null> {
  return asUser(userId, async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<ProfileRow[]>`
      SELECT user_id, display_name, avatar_url, timezone, locale, week_start_day,
             weight_unit, distance_unit, theme
        FROM user_profiles
       WHERE user_id = ${userId}::uuid
       LIMIT 1`;
    return rows[0] ?? null;
  });
}

export interface ProfilePatch {
  displayName?: string | null;
  timezone?: string;
  locale?: string;
  weekStartDay?: number;
  weightUnit?: 'kg' | 'lb';
  distanceUnit?: 'km' | 'mi';
  theme?: 'system' | 'light' | 'dark';
}

/**
 * A partial update where absent means "leave it alone" and an explicit null
 * means "clear it".
 *
 * COALESCE with a sentinel is the usual trick here and it is wrong: it makes
 * clearing a field impossible, because null is how you would ask for it. So
 * each field is passed twice, once as the value and once as a flag saying
 * whether it was supplied at all. Verbose, and it does what the caller asked.
 */
export function updateProfile(userId: string, patch: ProfilePatch): Promise<ProfileRow | null> {
  const hasDisplayName = 'displayName' in patch;
  const hasTimezone = patch.timezone !== undefined;
  const hasLocale = patch.locale !== undefined;
  const hasWeekStart = patch.weekStartDay !== undefined;
  const hasWeightUnit = patch.weightUnit !== undefined;
  const hasDistanceUnit = patch.distanceUnit !== undefined;
  const hasTheme = patch.theme !== undefined;

  return asUser(userId, async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<ProfileRow[]>`
      UPDATE user_profiles SET
        display_name   = CASE WHEN ${hasDisplayName}  THEN ${patch.displayName ?? null}::text  ELSE display_name  END,
        timezone       = CASE WHEN ${hasTimezone}     THEN ${patch.timezone ?? null}::text     ELSE timezone      END,
        locale         = CASE WHEN ${hasLocale}       THEN ${patch.locale ?? null}::text       ELSE locale        END,
        week_start_day = CASE WHEN ${hasWeekStart}    THEN ${patch.weekStartDay ?? null}::smallint ELSE week_start_day END,
        weight_unit    = CASE WHEN ${hasWeightUnit}   THEN ${patch.weightUnit ?? null}::text   ELSE weight_unit   END,
        distance_unit  = CASE WHEN ${hasDistanceUnit} THEN ${patch.distanceUnit ?? null}::text ELSE distance_unit END,
        theme          = CASE WHEN ${hasTheme}        THEN ${patch.theme ?? null}::text        ELSE theme         END
      WHERE user_id = ${userId}::uuid
      RETURNING user_id, display_name, avatar_url, timezone, locale, week_start_day,
                weight_unit, distance_unit, theme`;
    return rows[0] ?? null;
  });
}
