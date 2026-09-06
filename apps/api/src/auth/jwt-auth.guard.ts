import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TokenService } from './token.service.ts';
import { IS_PUBLIC, VERIFIED_EMAIL_REQUIRED, type RequestUser } from './auth.decorators.ts';

/**
 * The default is authenticated. Routes opt out with `@Public()`.
 *
 * Verification is signature-only: no database read on the hot path. That is the
 * trade an access token buys, and it is why the token lives ten minutes. A
 * session revoked thirty seconds ago still has a working access token for the
 * rest of its ten minutes, which is acceptable for reads and for the writes
 * this system does. Anything genuinely irreversible added later, deleting an
 * account or exporting everything, should check the session row as well; the
 * token carries `sid` so that check costs one indexed lookup.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('This request needs an access token.');
    }

    const claims = await this.tokens.verifyAccessToken(token);
    if (!claims) {
      throw new UnauthorizedException('That access token is not valid.');
    }

    const user: RequestUser = {
      id: claims.sub,
      sessionId: claims.sid,
      client: claims.cli,
      emailVerified: claims.evf,
    };
    request.user = user;

    const needsVerified = this.reflector.getAllAndOverride<boolean>(VERIFIED_EMAIL_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needsVerified && !user.emailVerified) {
      throw new ForbiddenException('Verify your email address before using this.');
    }

    return true;
  }
}

/**
 * Parses an Authorization header. Case-insensitive on the scheme, because
 * plenty of clients send "bearer", and strict about the rest: exactly two
 * parts, no empty token.
 */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, value] = parts;
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return value;
}
