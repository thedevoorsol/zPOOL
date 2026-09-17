import type { PoolClientFactory } from './pool-types';
import { config } from './config';
import { createMockClient } from './mockClient';
import { createRealClient } from './realClient';

/** The single place the UI obtains a pool client. VITE_MOCK=1 gives the in-browser demo. */
export const createPoolClient: PoolClientFactory = (args) => {
  if (config.mock) return createMockClient(args);
  return createRealClient(args);
};
