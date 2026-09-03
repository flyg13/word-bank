import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import toml from '@iarna/toml';

const ROOT = resolve(__dirname, '../..');
const netlify = toml.parse(readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const viteConfig = readFileSync(resolve(ROOT, 'vite.config.js'), 'utf8');

describe('netlify.toml', () => {
  it('publishes the directory Vite actually builds into', () => {
    // The failure this prevents is quiet: change outDir, and deploys keep
    // "succeeding" while publishing nothing.
    const outDir = viteConfig.match(/outDir:\s*'([^']+)'/)[1];
    expect(netlify.build.publish).toBe(outDir);
  });

  it('runs a build command that exists', () => {
    const scripts = [netlify.build.command, netlify.context.production.command]
      .join(' && ')
      .split('&&')
      .map((c) => c.trim().replace(/^npm (run )?/, ''));
    scripts.forEach((script) => expect(pkg.scripts).toHaveProperty(script));
  });

  it('gates production on the tests, but not previews', () => {
    expect(netlify.context.production.command).toContain('npm test');
    expect(netlify.build.command).not.toContain('npm test');
  });

  it('never lets the HTML be cached', () => {
    const html = netlify.headers.find((h) => h.for === '/index.html');
    expect(html.values['Cache-Control']).toContain('max-age=0');
  });

  it('keeps the site out of search results', () => {
    // A page titled with a child's name, on a memorable domain. Removing this
    // should be a decision, not an accident.
    const all = netlify.headers.find((h) => h.for === '/*');
    expect(all.values['X-Robots-Tag']).toBe('noindex');
  });

  it('caches hashed assets hard', () => {
    const assets = netlify.headers.find((h) => h.for === '/assets/*');
    expect(assets.values['Cache-Control']).toContain('immutable');
  });
});
