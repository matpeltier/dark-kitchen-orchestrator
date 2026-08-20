import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'apps/cli/README.md',
  'docs/architecture.md',
  'docs/installation.md',
  'docs/configuration.md',
  'docs/workflows.md',
  'docs/harnesses.md',
  'docs/trackers.md',
  'docs/interventions.md',
  'docs/mcp.md',
  'docs/troubleshooting.md',
];

const errors = [];

for (const relativeDocument of documents) {
  const absoluteDocument = resolve(repositoryRoot, relativeDocument);
  let markdown;
  try {
    markdown = await readFile(absoluteDocument, 'utf8');
  } catch (error) {
    errors.push(`${relativeDocument}: missing required document (${String(error)})`);
    continue;
  }

  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/gu)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || isExternal(rawTarget)) continue;
    const targetWithoutTitle = rawTarget.replace(/^<|>$/gu, '').split(/\s+["']/u, 1)[0] ?? '';
    const filePart = targetWithoutTitle.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (!filePart) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(filePart);
    } catch {
      errors.push(`${relativeDocument}: invalid percent encoding in ${rawTarget}`);
      continue;
    }
    const linkedPath = resolve(dirname(absoluteDocument), decoded);
    if (!linkedPath.startsWith(repositoryRoot)) {
      errors.push(`${relativeDocument}: local link escapes the repository: ${rawTarget}`);
      continue;
    }
    try {
      await stat(linkedPath);
    } catch {
      errors.push(`${relativeDocument}: broken local link ${rawTarget}`);
    }
  }
}

const architectureImage = resolve(repositoryRoot, 'docs/assets/dark-kitchen-architecture.png');
try {
  const png = await readFile(architectureImage);
  const signature = png.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a' || png.length < 24) {
    errors.push('docs/assets/dark-kitchen-architecture.png: invalid PNG');
  } else {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width < 1200 || height < 600) {
      errors.push(`architecture image is too small (${width}x${height})`);
    }
  }
} catch (error) {
  errors.push(`architecture image missing (${String(error)})`);
}

if (errors.length > 0) {
  process.stderr.write(`Documentation validation failed:\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Documentation validation passed (${documents.length} Markdown files).\n`);
}

function isExternal(target) {
  return (
    target.startsWith('#') ||
    target.startsWith('mailto:') ||
    target.startsWith('http://') ||
    target.startsWith('https://')
  );
}
