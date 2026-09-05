import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import toml from '@iarna/toml';

const ROOT = resolve(__dirname, '../..');
const netlify = toml.parse(readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const viteConfig = readFileSync(resolve(ROOT, 'vite.config.js'), 'utf8');
const redirectPage = readFileSync(resolve(ROOT, 'redirect/index.html'), 'utf8');
const pagesWorkflow = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');

const PRODUCTION = 'https://wordbank.flyinggiraffe.ai/';

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

describe('the old GitHub Pages URL', () => {
  it('redirects to production three independent ways', () => {
    // Pages serves static files and cannot issue a 301, so belt, braces and a
    // visible link: any one of them failing still gets the family there.
    expect(redirectPage).toContain('location.replace');
    expect(redirectPage).toMatch(/http-equiv="refresh"[^>]*url=https:\/\/wordbank\.flyinggiraffe\.ai/);
    expect(redirectPage).toContain('<a href="' + PRODUCTION + '"');
  });

  it('carries the query string and fragment across', () => {
    expect(redirectPage).toContain('location.search');
    expect(redirectPage).toContain('location.hash');
  });

  it('stays out of search results and points crawlers at the new address', () => {
    expect(redirectPage).toContain('name="robots" content="noindex"');
    expect(redirectPage).toContain('rel="canonical" href="' + PRODUCTION + '"');
  });

  it('is published by the Pages workflow, which no longer builds the app', () => {
    expect(pagesWorkflow).toContain('redirect/index.html');
    expect(pagesWorkflow).toContain('_site/404.html'); // deep paths redirect too
    expect(pagesWorkflow).not.toContain('npm run build');
  });
});
