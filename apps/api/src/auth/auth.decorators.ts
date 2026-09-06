import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface RequestUser {
  id: string;
  sessionId: string;
  client: 'daybook' | 'fitness';
  emailVerified: boolean;
}

/**
 * Requests carry their authenticated user here once the guard has run.
 *
 * Declared through module augmentation rather than by casting at each use, so
 * a handler that reads `request.user` gets the real type and a typo is a
 * compile error.
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

export const IS_PUBLIC = 'auth:public';

/**
 * Marks a route as reachable without a token.
 *
 * The guard is global and the default is closed: a new controller added in a
 * later phase is protected the moment it exists, and opening it up is a visible,
 * deliberate line of code. The opposite arrangement, where routes opt in to
 * protection, leaks a resource every time someone forgets.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export const VERIFIED_EMAIL_REQUIRED = 'auth:verified';

/** For the routes that need a real, proven address rather than just a session. */
export const RequiresVerifiedEmail = (): MethodDecorator & ClassDecorator =>
  SetMetadata(VERIFIED_EMAIL_REQUIRED, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.user) {
      // Unreachable behind the guard. Throwing rather than returning undefined
      // means a route accidentally marked public but expecting a user fails
      // immediately and obviously, instead of reading properties of undefined
      // three frames deeper.
      throw new Error('CurrentUser used on a route with no authentication guard');
    }
    return request.user;
  },
);
