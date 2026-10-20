import { defineConfig } from 'vitest/config';

// Tests against the real Plex account in the repository's .env; never part of `npm test`.
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    environment: 'node',
  },
});
