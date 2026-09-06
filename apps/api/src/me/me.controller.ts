import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  UnprocessableEntityException,
} from '@nestjs/common';
import { findUserById, getProfile, updateProfile } from '@daybook/db';
import { assertValidTimeZone } from '@daybook/domain';
import { updateProfileRequest, type Me } from '@daybook/contracts';
import { validate } from '../common/zod.pipe.ts';
import { CurrentUser, type RequestUser } from '../auth/auth.decorators.ts';

/**
 * The signed-in person's own record.
 *
 * Nothing here takes a user id from the request. It comes from the verified
 * access token, and the profile queries run under row-level security as that
 * user, so there is no path by which a crafted request reaches somebody else's
 * row: not a missing WHERE clause, not an id in a URL, not a JSON body with an
 * extra field. That is the property Phase 3's exit criterion tests.
 */
@Controller('me')
export class MeController {
  @Get()
  async me(@CurrentUser() user: RequestUser): Promise<Me> {
    const [account, profile] = await Promise.all([findUserById(user.id), getProfile(user.id)]);
    if (!account || !profile) {
      // The token verified, so the account existed when it was issued. Reaching
      // here means it has since been deleted.
      throw new NotFoundException('That account no longer exists.');
    }
    return present(account.email, account.email_verified_at !== null, profile);
  }

  @Patch()
  async update(
    @CurrentUser() user: RequestUser,
    @Body(validate(updateProfileRequest))
    body: {
      display_name?: string | null;
      timezone?: string;
      locale?: string;
      week_start_day?: number;
      weight_unit?: 'kg' | 'lb';
      distance_unit?: 'km' | 'mi';
      theme?: 'system' | 'light' | 'dark';
    },
  ): Promise<Me> {
    if (body.timezone !== undefined) {
      try {
        assertValidTimeZone(body.timezone);
      } catch {
        throw new UnprocessableEntityException(`Unknown IANA timezone: ${body.timezone}`);
      }
    }

    const profile = await updateProfile(user.id, {
      // 'display_name' in body distinguishes "clear it" from "leave it", which
      // is why the repository takes the presence of the key rather than the
      // value. Spelling it out here keeps that distinction from being lost in
      // an object spread.
      ...('display_name' in body ? { displayName: body.display_name ?? null } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.week_start_day !== undefined ? { weekStartDay: body.week_start_day } : {}),
      ...(body.weight_unit !== undefined ? { weightUnit: body.weight_unit } : {}),
      ...(body.distance_unit !== undefined ? { distanceUnit: body.distance_unit } : {}),
      ...(body.theme !== undefined ? { theme: body.theme } : {}),
    });

    const account = await findUserById(user.id);
    if (!profile || !account) {
      throw new NotFoundException('That account no longer exists.');
    }
    return present(account.email, account.email_verified_at !== null, profile);
  }
}

function present(
  email: string,
  emailVerified: boolean,
  profile: {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
    timezone: string;
    locale: string;
    week_start_day: number;
    weight_unit: 'kg' | 'lb';
    distance_unit: 'km' | 'mi';
    theme: 'system' | 'light' | 'dark';
  },
): Me {
  return {
    id: profile.user_id,
    email,
    email_verified: emailVerified,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    timezone: profile.timezone,
    locale: profile.locale,
    week_start_day: profile.week_start_day,
    weight_unit: profile.weight_unit,
    distance_unit: profile.distance_unit,
    theme: profile.theme,
  };
}
