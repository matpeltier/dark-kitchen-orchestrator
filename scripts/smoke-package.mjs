import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageDirectory = join(root, 'apps', 'cli');
const scratch = await mkdtemp(join(tmpdir(), 'dark-kitchen-package-'));

try {
  await exec('pnpm', ['--filter', 'dark-kitchen', 'build'], { cwd: root });
  const packed = await exec('npm', ['pack', '--json'], { cwd: packageDirectory });
  const packResult = JSON.parse(packed.stdout)[0];
  if (!packResult?.filename) throw new Error('npm pack did not return a tarball filename.');
  const tarball = join(packageDirectory, packResult.filename);

  const project = join(scratch, 'consumer');
  await exec('npm', ['init', '-y'], { cwd: scratch });
  await exec('npm', ['install', tarball, '--ignore-scripts'], {
    cwd: scratch,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
  });
  await exec('git', ['init', '--initial-branch=main', project]);
  const binDirectory = join(scratch, 'node_modules', '.bin');
  const environment = {
    ...process.env,
    PATH: `${binDirectory}${delimiter}${process.env['PATH'] ?? ''}`,
  };
  const cli = join(scratch, 'node_modules', 'dark-kitchen', 'dist', 'cli.js');

  const help = await exec(process.execPath, [cli, '--help'], { cwd: project, env: environment });
  if (!help.stdout.includes('Dark Kitchen')) throw new Error('Packed CLI help smoke failed.');
  const version = await exec(process.execPath, [cli, '--version'], {
    cwd: project,
    env: environment,
  });
  if (!/^0\.1\.1\s*$/u.test(version.stdout)) throw new Error('Packed CLI version smoke failed.');
  await exec(process.execPath, [cli, 'init'], { cwd: project, env: environment });
  const initializedConfig = await readFile(join(project, '.dark-kitchen', 'config.yaml'), 'utf8');
  for (const role of ['implementer', 'reviewer', 'fixer', 'repository-tester']) {
    if (!initializedConfig.includes(`id: ${role}`)) {
      throw new Error(`Packed CLI init omitted required semantic role ${role}.`);
    }
  }
  await exec(process.execPath, [cli, 'doctor'], { cwd: project, env: environment });

  const installedManifest = JSON.parse(
    await readFile(join(scratch, 'node_modules', 'dark-kitchen', 'package.json'), 'utf8'),
  );
  const productionSpecs = Object.values(installedManifest.dependencies ?? {});
  if (productionSpecs.some((spec) => String(spec).startsWith('workspace:'))) {
    throw new Error('Packed CLI leaked a workspace:* production dependency.');
  }
  process.stdout.write(`Package smoke passed: ${packResult.filename}\n`);
  await rm(tarball, { force: true });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
