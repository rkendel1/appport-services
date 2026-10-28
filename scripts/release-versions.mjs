#!/usr/bin/env node
// The three packages in this repository release as a chain:
//   @appport/services  <-  @appport/runtime (re-exports it)  <-  create-appport (scaffolds on it)
// Each declares a caret range on the one before it. On 0.x a caret range only
// spans one minor (^0.4.9 accepts no 0.5.x), so a services minor release that
// does not move the chain leaves `npx create-appport` installing the previous
// services. That is what happened at 0.5.0.
//
//   node scripts/release-versions.mjs check            refuse a chain that drifted
//   node scripts/release-versions.mjs bump <kind>      bump services by <kind> and move the chain
//
// bump: runtime takes the same increment as services (its API is services'),
// create-appport takes a patch. Ranges become ^<new version>.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = {
  services: 'package.json',
  runtime: 'packages/runtime/package.json',
  create: 'packages/create-appport/package.json',
};

const read = (file) => JSON.parse(readFileSync(`${root}/${file}`, 'utf8'));
const write = (file, value) => writeFileSync(`${root}/${file}`, `${JSON.stringify(value, null, 2)}\n`);

function next(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`cannot increment non-stable version ${version}`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (kind === 'minor') [minor, patch] = [minor + 1, 0];
  else if (kind === 'patch') patch += 1;
  else throw new Error(`unknown increment ${kind}; use patch, minor or major`);
  return `${major}.${minor}.${patch}`;
}

export function chainErrors() {
  const services = read(files.services);
  const runtime = read(files.runtime);
  const create = read(files.create);
  const errors = [];
  const want = (manifest, file, name, version) => {
    const range = manifest.dependencies?.[name];
    if (range !== `^${version}`) errors.push(`${file}: dependencies.${name} is ${range}; expected ^${version} (the version in this repository)`);
  };
  want(runtime, files.runtime, services.name, services.version);
  want(create, files.create, runtime.name, runtime.version);
  const lock = read('package-lock.json');
  if (lock.version !== services.version || lock.packages?.['']?.version !== services.version) {
    errors.push(`package-lock.json: version is ${lock.version}; expected ${services.version}`);
  }
  return errors;
}

export function bump(kind) {
  const services = read(files.services);
  const runtime = read(files.runtime);
  const create = read(files.create);
  const from = { services: services.version, runtime: runtime.version, create: create.version };

  services.version = next(services.version, kind);
  runtime.version = next(runtime.version, kind);
  runtime.dependencies[services.name] = `^${services.version}`;
  create.version = next(create.version, 'patch');
  create.dependencies[runtime.name] = `^${runtime.version}`;

  const lock = read('package-lock.json');
  lock.version = services.version;
  lock.packages[''].version = services.version;

  write(files.services, services);
  write(files.runtime, runtime);
  write(files.create, create);
  write('package-lock.json', lock);
  return { from, to: { services: services.version, runtime: runtime.version, create: create.version } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, kind] = process.argv.slice(2);
  if (command === 'bump' && kind) {
    const { from, to } = bump(kind);
    for (const key of Object.keys(to)) console.log(`${key.padEnd(8)} ${from[key]} -> ${to[key]}`);
    console.log('Add the CHANGELOG entry, then run `npm test`.');
  } else if (command === 'check' && !kind) {
    const errors = chainErrors();
    if (errors.length) {
      console.error(`Package versions drifted:\n- ${errors.join('\n- ')}\nRun: node scripts/release-versions.mjs bump <patch|minor|major>`);
      process.exit(1);
    }
    console.log('Package version chain is consistent.');
  } else {
    console.error('usage: node scripts/release-versions.mjs check | bump <patch|minor|major>');
    process.exit(2);
  }
}
