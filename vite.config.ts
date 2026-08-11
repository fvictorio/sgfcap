import { defineConfig } from 'vitest/config';

// One config for both the app and the tests, so the two cannot drift apart.
export default defineConfig({
  // Relative asset URLs, so the built page works wherever it is served from: the repo
  // subpath GitHub Pages uses, a domain root, or straight off the filesystem. The
  // alternative is hard-coding the repository name as the base, which breaks the moment
  // the site moves. Safe here because the app is a single page with no routing.
  base: './',
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
