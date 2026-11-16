#!/usr/bin/env node
/**
 * Vendor the Calliope AI design system's terminal token mapping
 * (@calliopelabs/ui `dist/tokens/tokens.terminal.js` and its types) into
 * src/vendor/calliope-ui/, until the CLI takes the package itself.
 *
 *   node scripts/vendor-calliope-ui.mjs 0.20.0
 *     downloads the published tarball and checks it against the registry's
 *     integrity before writing anything;
 *   node scripts/vendor-calliope-ui.mjs --tarball calliopelabs-ui-0.20.0.tgz --source calliopeai/calliope-ui@<commit>
 *     takes a packed tarball (`npm pack` in calliope-ui) of a version not
 *     published yet, and records where it came from.
 *
 * Each file's header records the version, the source and the sha256 of the
 * body after it; tests/vendored-calliope-ui.test.ts re-checks them, so a hand
 * edit fails CI. To move to the package: add @calliopelabs/ui, import
 * `@calliopelabs/ui/tokens/terminal` in src/hud/terminal-theme.ts, and delete
 * src/vendor/calliope-ui/, this script and its test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const dest = join(root, 'src/vendor/calliope-ui');
const FILES = ['dist/tokens/tokens.terminal.js', 'dist/tokens/tokens.terminal.d.ts'];
const REGISTRY = 'https://registry.npmjs.org/@calliopelabs%2fui/';

/** Every regular file of a tar archive, by name. */
function untar(buffer) {
  const files = new Map();
  let longName = null;
  for (let at = 0; at + 512 <= buffer.length; ) {
    const header = buffer.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = buffer.subarray(at + 512, at + 512 + size);
    longName = null;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0') files.set(name, body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function download(version) {
  const meta = await (await fetch(REGISTRY + version)).json();
  if (!meta.dist) throw new Error(`@calliopelabs/ui@${version} is not on npm`);
  const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const [algorithm, expected] = meta.dist.integrity.split('-');
  if (createHash(algorithm).update(tarball).digest('base64') !== expected) {
    throw new Error(`integrity mismatch for ${meta.dist.tarball}`);
  }
  return tarball;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tarball: { type: 'string' }, source: { type: 'string' } },
});
if (values.tarball ? positionals.length > 0 || !values.source : positionals.length !== 1) {
  console.error('usage: vendor-calliope-ui.mjs <version> | --tarball <file.tgz> --source <repo@commit>');
  process.exit(2);
}
const tarball = values.tarball ? readFileSync(values.tarball) : await download(positionals[0]);
const files = untar(gunzipSync(tarball));
const pkg = JSON.parse(files.get('package/package.json')?.toString('utf8') ?? '{}');
if (pkg.name !== '@calliopelabs/ui') throw new Error('not an @calliopelabs/ui tarball');
const source = values.tarball ? `${values.source} (unpublished)` : 'npm';
mkdirSync(dest, { recursive: true });
for (const member of FILES) {
  const body = files.get(`package/${member}`)?.toString('utf8');
  if (body === undefined) throw new Error(`${member} is not in @calliopelabs/ui@${pkg.version}`);
  const sha = createHash('sha256').update(body).digest('hex');
  const header = [
    `/* Vendored from @calliopelabs/ui@${pkg.version} ${member}`,
    ` * source: ${source}`,
    ` * sha256:${sha}`,
    ' * Do not edit. Run scripts/vendor-calliope-ui.mjs to update. */',
    '',
  ].join('\n');
  const file = join(dest, member.split('/').pop());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, header + body);
  console.log(`wrote ${file.slice(root.length)} (@calliopelabs/ui@${pkg.version}, sha256:${sha})`);
}
