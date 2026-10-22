// Adapt the compute-observer output (Compute's unmodified service_ui::discover,
// run over HTTP per document) to v1 results. A consumer repo would emit ids directly.
import { readFileSync, writeFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(new URL('../../appport-ui-1/cases.json', import.meta.url), 'utf8')).cases;
const byTitle = new Map(cases.map((c) => [c.title, c.id]));
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
writeFileSync(process.argv[3], rows.map((r) => JSON.stringify({
  id: byTitle.get(r.name),
  verdict: r.status === 'available' || r.status === 'empty' ? 'accept' : 'reject',
  detail: `${r.status}${r.message ? `: ${r.message}` : ''}`,
})).join('\n') + '\n');
