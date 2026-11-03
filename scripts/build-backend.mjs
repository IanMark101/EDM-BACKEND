import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const generated = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'generate'], { cwd: path.join(root, 'backend'), stdio: 'inherit', windowsHide: true });
if (generated.status !== 0) process.exit(generated.status || 1);
await build({ entryPoints: [path.join(root, 'backend/src/index.ts')], outfile: path.join(root, 'backend/dist/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
console.log('Express backend build complete.');
