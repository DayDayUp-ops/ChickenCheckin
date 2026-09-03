import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(projectRoot, 'dist-pages');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await Promise.all([
  copyFile(resolve(projectRoot, 'public', 'index.html'), resolve(outputDir, 'index.html')),
  copyFile(resolve(projectRoot, 'src', 'worker.js'), resolve(outputDir, '_worker.js')),
  writeFile(
    resolve(outputDir, '_routes.json'),
    `${JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2)}\n`,
    'utf8',
  ),
  writeFile(
    resolve(outputDir, '_headers'),
    `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Cache-Control: no-cache\n`,
    'utf8',
  ),
]);

const html = await readFile(resolve(outputDir, 'index.html'), 'utf8');
if (!html.includes('id="cloud-sync-button"')) {
  throw new Error('Cloud sync UI is missing from the Pages output.');
}

console.log(`Built Cloudflare Pages output: ${outputDir}`);
