/** The documented example runs end to end against the built package, through a provider restart. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('examples/feedback-store/example.mjs: submit, restart, resolve, read', () => {
  const script = fileURLToPath(new URL('../../examples/feedback-store/example.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }));
  assert.equal(out.replayedSameReceipt, true);
  assert.deepEqual(out.transitions, ['acknowledged', 'investigating', 'accepted', 'in_progress', 'verified', 'resolved']);
  assert.equal(out.state, 'resolved');
  assert.deepEqual(out.next, { action: 'retry_after_upgrade', upgrade: { api: '3.2.1' } });
  assert.deepEqual(out.queue.map((h: { state: string }) => h.state), ['resolved']);
});
