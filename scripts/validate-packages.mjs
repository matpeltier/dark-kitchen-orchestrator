import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceDirectories = ['apps', 'packages'];
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const forbiddenDependencyNames = ['orca', 'codex-dynamic-workflows'];

const readManifest = async (manifestPath) => {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${relative(root, manifestPath)}: ${error.message}`);
  }
};

const manifestPaths = [join(root, 'package.json')];

for (const directory of workspaceDirectories) {
  const directoryPath = join(root, directory);
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      manifestPaths.push(join(directoryPath, entry.name, 'package.json'));
    }
  }
}

const manifests = await Promise.all(
  manifestPaths.map(async (manifestPath) => ({
    manifest: await readManifest(manifestPath),
    path: manifestPath,
  })),
);
const packageNames = new Set();
const errors = [];

for (const { manifest, path } of manifests) {
  const displayPath = relative(root, path);

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    errors.push(`${displayPath} must declare a package name`);
  } else if (packageNames.has(manifest.name)) {
    errors.push(`duplicate package name: ${manifest.name}`);
  } else {
    packageNames.add(manifest.name);
  }

  for (const field of dependencyFields) {
    for (const dependencyName of Object.keys(manifest[field] ?? {})) {
      if (
        forbiddenDependencyNames.some((forbidden) =>
          dependencyName.toLowerCase().includes(forbidden),
        )
      ) {
        errors.push(`${displayPath} declares forbidden dependency ${dependencyName}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${manifests.length} workspace manifests.`);
