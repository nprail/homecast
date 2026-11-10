import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Emits dist/sw.js: the template with a precache list of the built shell and a content-hash version. */
function serviceWorker(): Plugin {
  return {
    name: 'homecast-sw',
    apply: 'build',
    generateBundle(_o, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const precache = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', ...files.filter((f) => !f.endsWith('.woff2') || f.includes('latin-wght')).map((f) => `/${f}`)];
      const version = createHash('sha1').update(files.join('|') + files.map((f) => ('code' in bundle[f]! ? (bundle[f] as { code: string }).code.length : 0)).join(',')).digest('hex').slice(0, 10);
      const tpl = readFileSync(path.resolve(__dirname, 'sw/sw.template.js'), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: tpl.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify([...new Set(precache)])) });
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: false },
});
