import { defineConfig } from 'vitest/config';

// Live, model-backed evaluation (npm run eval). Not part of `npm test`:
// it costs API calls and needs ANTHROPIC_API_KEY or OPENAI_API_KEY.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30 * 60_000,
  },
});
