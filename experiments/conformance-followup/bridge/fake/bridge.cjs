// EXPERIMENT fake bridge speaking the same line protocol as
// authboundry/bridge/appport-services.cjs, to inject faults the real one
// cannot be made to produce on demand. Operations: echo, hang, noise, exit.
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const { operation, request } = JSON.parse(line);
  if (operation === 'hang') return; // never answers
  if (operation === 'exit') process.exit(1);
  if (operation === 'noise') process.stdout.write('[CAS-x] stray diagnostic line\n');
  process.stdout.write(JSON.stringify({ ok: true, value: { echo_n: request.n ?? null, operation } }) + '\n');
});
