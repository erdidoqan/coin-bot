import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'admin', 'out');
const dest = join(root, 'public', 'admin');

if (!existsSync(src)) {
  console.error('admin/out missing — run: cd admin && npm run build');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(root, 'public'), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('Copied admin/out → public/admin');
