import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(projectRoot, 'dist-pages');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await Promise.all([
  copyFile(resolve(projectRoot, 'public', 'index.html'), resolve(outputDir, 'index.html')),
  copyFile(resolve(projectRoot, 'public', 'app-logo.png'), resolve(outputDir, 'app-logo.png')),
  copyFile(resolve(projectRoot, 'public', 'default-avatar.png'), resolve(outputDir, 'default-avatar.png')),
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
if (!html.includes('id="cloud-reset-panel"') || !html.includes('placeholder="至少6位"')) {
  throw new Error('Cloud password recovery UI is missing from the Pages output.');
}
if (!html.includes('id="avatar-upload"') || !html.includes('id="background-upload"') || !html.includes('SPORT_OPTIONS')) {
  throw new Error('3.0 personalization UI is missing from the Pages output.');
}

const worker = await readFile(resolve(outputDir, '_worker.js'), 'utf8');
if (!worker.includes("'/api/reset-password'") || !worker.includes('env.RECOVERY_CODE')) {
  throw new Error('Cloud password recovery API is missing from the Pages output.');
}

console.log(`Built Cloudflare Pages output: ${outputDir}`);
