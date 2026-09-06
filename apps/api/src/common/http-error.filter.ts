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

    /**
     * Fastify and its plugins throw plain errors carrying their own status:
     * a malformed JSON body, a payload over the size limit, an exhausted rate
     * limit. Treating those as unhandled turns a 400 the client caused into a
     * 500 that looks like our fault, and buries the only useful part of the
     * message.
     */
    const fastifyStatus = statusOf(exception);
    if (fastifyStatus !== null && fastifyStatus < 500) {
      reply.status(fastifyStatus).send({
        error: {
          code: codeForStatus(fastifyStatus),
          message: messageOf(exception) ?? 'That request could not be accepted.',
          request_id: requestId,
        },
      });
      return;
    }

    // Anything left is a bug.
    //
    // It goes to the request logger, and outside production it also goes to
    // stderr with its stack. Relying on the logger alone is how "the problem
    // has been recorded" became untrue: a log level, a redaction rule or a
    // logger that was never attached is enough to make an unhandled exception
    // vanish, which leaves a 500 with nothing behind it anywhere.
    request.log?.error({ err: exception, requestId }, 'unhandled exception');
    if (process.env.NODE_ENV !== 'production') {
      console.error(`\n[${requestId}] unhandled exception on ${request.method} ${request.url}`);
      console.error(exception);
    }

    reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong at our end. The problem has been recorded.',
        request_id: requestId,
      },
    });
  }
}

function statusOf(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const status = (exception as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : null;
}

function messageOf(exception: unknown): string | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const message = (exception as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

function codeForStatus(status: number): string {
  const codes: Record<number, string> = {
    400: 'bad_request',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'payload_too_large',
    415: 'unsupported_media_type',
    422: 'validation_failed',
    429: 'rate_limited',
  };
  return codes[status] ?? 'error';
}
