#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , requestedName, ...flags] = process.argv;
if (!requestedName || requestedName.startsWith('-')) {
  process.stderr.write('Usage: npx create-appport <application-name> [--no-install]\n');
  process.exitCode = 1;
} else {
  await createApplication(requestedName, !flags.includes('--no-install'));
}

async function createApplication(name, install) {
  const target = resolve(name);
  try { await access(target); throw new Error(`Target already exists: ${target}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(resolve(target, 'src'), { recursive: true });
  await writeFile(resolve(target, 'package.json'), JSON.stringify({
    name: packageName(name), version: '0.1.0', private: true, type: 'module',
    scripts: { dev: 'node --watch src/app.js', start: 'node src/app.js' },
    dependencies: { '@appport/runtime': '^0.3.0' },
  }, null, 2) + '\n');
  await writeFile(resolve(target, 'src/app.js'), `import { appport } from '@appport/runtime';

const application = await appport({
  routes: {
    'GET /': async ({ services }) => ({ application: application.contract.application.name, jobs: await services.jobs.listJobs() }),
  },
  jobHandlers: {
    'example.process': async (job) => {
      // Add application behavior here.
      console.log('Processing job', job.id);
    },
  },
});

console.log(\`AppPort listening at \${application.http?.url}\`);
`);
  const runtimeEntry = fileURLToPath(import.meta.resolve('@appport/runtime'));
  await run(process.execPath, [resolve(dirname(runtimeEntry), 'cli.js'), 'init', '--use', 'api,webhooks,jobs'], target);
  if (install) await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], target);
  process.stdout.write(`\nCreated ${packageName(name)} in ${target}\n\n  cd ${name}\n  npm run dev\n`);
}

function packageName(value) { return value.split(/[\\/]/).filter(Boolean).at(-1).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'); }
function run(command, args, cwd) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`))); }); }
