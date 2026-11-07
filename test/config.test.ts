import { afterEach, expect, it, vi } from 'vitest';

// Exercise defaults independently of any local .env file.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('defaults the total LiteLLM pull budget to 60 seconds', async () => {
  vi.stubEnv('LLM_PROXY_TIMEOUT_MS', undefined);
  const { config } = await import('../src/config');
  expect(config.llmTimeoutMs).toBe(60_000);
});

it('preserves an explicitly configured LiteLLM pull budget', async () => {
  vi.stubEnv('LLM_PROXY_TIMEOUT_MS', '90000');
  const { config } = await import('../src/config');
  expect(config.llmTimeoutMs).toBe(90_000);
});
