import { defineConfig } from 'vite';

export default defineConfig({
  // Plain static site, no framework plugins needed.
  build: {
    target: 'es2020',
  },
});
