import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base, so the build is origin- and path-agnostic: it works at
  // https://wordbank.flyinggiraffe.ai, at a Netlify preview subdomain, and at
  // a repo subpath. Nothing in the app hardcodes its own URL.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
