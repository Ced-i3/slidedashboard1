import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUTPUT = resolve(ROOT, 'dist');
const PUBLIC_FILES = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js'];

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Unsupported entry in public assets: ${from}`);
  }
}

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
for (const name of PUBLIC_FILES) await copyFile(join(ROOT, name), join(OUTPUT, name));
await copyDirectory(join(ROOT, 'assets'), join(OUTPUT, 'assets'));
process.stdout.write('Built the dashboard into dist/.\n');
