import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = join(functionsDir, '.azd-deploy');

await rm(deployDir, { force: true, recursive: true });
await mkdir(deployDir, { recursive: true });
await Promise.all([
  cp(join(functionsDir, 'dist'), join(deployDir, 'dist'), { recursive: true }),
  cp(join(functionsDir, 'host.json'), join(deployDir, 'host.json')),
  cp(join(functionsDir, 'package.json'), join(deployDir, 'package.json')),
]);

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('npm_execpath is not set; run this packager through npm');
}

const install = spawnSync(
  process.execPath,
  [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--workspaces=false'],
  { cwd: deployDir, stdio: 'inherit' },
);

if (install.error) {
  throw install.error;
}
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}