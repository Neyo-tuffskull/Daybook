import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a Zod schema from `@daybook/contracts`.
 *
 * The schemas are the same objects the frontends import, so a field renamed in
 * one place fails to compile in the other rather than failing at runtime in
 * production. The pipe throws the ZodError untouched; the global error filter
 * turns it into the 422 with per-field detail that the API contract promises.
 *
 * `.strict()` on the schemas matters here: an unexpected property is rejected
 * rather than ignored, so a client sending `is_admin: true` gets a 422 instead
 * of a silent no-op that somebody might later turn into a real field.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    return this.schema.parse(value);
  }
}

/** Reads better at the call site: `@Body(validate(loginRequest)) body: LoginRequest`. */
export function validate<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
