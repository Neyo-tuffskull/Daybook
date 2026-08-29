import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * One error shape for the entire API. Internals never reach the client: no
 * stack traces, no SQL, no Prisma error text. The request id is the bridge
 * between what the user can see and what the logs contain.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = String(request.id);

    if (exception instanceof ZodError) {
      reply.status(422).send({
        error: {
          code: 'validation_failed',
          message: 'Some of the values sent were not valid.',
          details: exception.issues.map((issue) => ({
            field: issue.path.join('.') || undefined,
            issue: issue.message,
          })),
          request_id: requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message);
      reply.status(status).send({
        error: { code: codeForStatus(status), message, request_id: requestId },
      });
      return;
    }

    // Anything unrecognised is a bug. Log it in full, tell the user nothing.
    request.log.error({ err: exception, requestId }, 'unhandled exception');
    reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong at our end. The problem has been recorded.',
        request_id: requestId,
      },
    });
  }
}

function codeForStatus(status: number): string {
  const codes: Record<number, string> = {
    400: 'bad_request',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    422: 'validation_failed',
    429: 'rate_limited',
  };
  return codes[status] ?? 'error';
}
