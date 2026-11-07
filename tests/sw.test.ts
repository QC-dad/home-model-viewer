import { describe, expect, it } from 'vitest';
import { generateServiceWorker } from '../sw-template';

describe('generated service worker', () => {
  it('resolves precache entries against registration scope for subpath installs', () => {
    const source = generateServiceWorker(['index.html', 'assets/app.js', 'icon-192.png'], 'build-test');
    expect(source).toContain("new URL(path, scopeUrl()).href");
    expect(source).toContain('index.html');
    expect(source).toContain('assets/app.js');
    expect(source).not.toContain('"/assets/app.js"');
    expect(source).toContain("event.request.mode === 'navigate'");
    expect(source).toContain("key.startsWith(CACHE_PREFIX)");
    expect(source).toContain("CACHE_PREFIX + \"build-test\"");
  });
});
