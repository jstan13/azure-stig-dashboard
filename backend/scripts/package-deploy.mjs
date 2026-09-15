import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createTar } from 'tar';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = join(backendDir, '.azd-deploy');

await rm(deployDir, { force: true, recursive: true });
await mkdir(deployDir, { recursive: true });
await Promise.all([
  cp(join(backendDir, 'dist'), join(deployDir, 'dist'), { recursive: true }),
  cp(join(backendDir, 'package.json'), join(deployDir, 'package.json')),
  cp(join(backendDir, 'openapi.yaml'), join(deployDir, 'openapi.yaml')),
]);

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('npm_execpath is not set; run this packager through npm');
}

const install = spawnSync(
  process.execPath,
  [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--workspaces=false'],
  {
    cwd: deployDir,
    stdio: 'inherit',
  },
);

if (install.error) {
  throw install.error;
}
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

await createTar(
  {
    cwd: join(deployDir, 'node_modules'),
    file: join(deployDir, 'node_modules.tar.gz'),
    gzip: true,
  },
  ['.'],
);

await rm(join(deployDir, 'node_modules'), { force: true, recursive: true });
await writeFile(
  join(deployDir, 'oryx-manifest.toml'),
  'compressedNodeModulesFile="node_modules.tar.gz"\n',
);