import type { Provider } from '@nestjs/common';
import { loadConfig, type AppConfig } from './config.ts';

/**
 * Configuration reaches the rest of the application by injection rather than by
 * reading process.env wherever it is needed.
 *
 * That is not ceremony. It means the validation in loadConfig runs exactly
 * once, at boot, so a missing key stops the process instead of throwing on the
 * first sign-in; and it means a test can hand a service a different
 * configuration without mutating global state that the next test inherits.
 */
export const CONFIG = Symbol('APP_CONFIG');

export const configProvider: Provider = {
  provide: CONFIG,
  useFactory: (): AppConfig => loadConfig(),
};
