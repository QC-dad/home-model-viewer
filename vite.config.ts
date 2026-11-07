import { defineConfig, type Plugin } from 'vite';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateServiceWorker } from './sw-template';

async function filesIn(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(path, name));
    else files.push(name);
  }
  return files;
}

function offlineServiceWorker(): Plugin {
  return {
    name: 'offline-service-worker',
    apply: 'build',
    async closeBundle() {
      const outDir = join(process.cwd(), 'dist');
      const emitted = await filesIn(outDir);
      const cacheFiles = emitted.filter((path) => path !== 'sw.js');
      const source = generateServiceWorker(cacheFiles, `build-${Date.now()}`);
      await writeFile(join(outDir, 'sw.js'), source, 'utf8');
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  plugins: [offlineServiceWorker()],
});
