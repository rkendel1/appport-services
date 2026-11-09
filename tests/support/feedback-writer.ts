/**
 * A provider process for the crash test: opens the store at argv[2] (shared access), submits records and drives
 * their lifecycles as fast as it can, forever. The test kills it with SIGKILL mid-write and then checks every record.
 */
import { createFeltDB } from '@feltdb/core';

import { FeltDbFeedbackStore } from '../../src/storage/feedback.js';
import { feedbackRig } from './feedback.js';

const path = process.argv[2]!;
const db = createFeltDB({ mode: 'local', namespace: 'feedback', path, access: 'shared' } as never);
const rig = await feedbackRig(new FeltDbFeedbackStore(db, { tenantId: 'tenant-a' }));
process.stdout.write('ready\n');
for (let n = 0; ; n += 1) {
  const { feedbackId } = await rig.reporter.submit(rig.report());
  await rig.provider.acknowledge(feedbackId);
  await rig.provider.investigate(feedbackId);
  await rig.provider.accept(feedbackId);
  await rig.provider.startWork(feedbackId);
  if (n % 5 === 0) process.stdout.write(`${n}\n`);
}
