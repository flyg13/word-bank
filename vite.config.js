import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from a repo-subpath GitHub Pages URL
  // (https://<user>.github.io/word-bank/) as well as from a domain root.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
