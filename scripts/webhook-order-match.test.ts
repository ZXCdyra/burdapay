import assert from 'node:assert/strict';
import { getWebhookOrderCandidates } from '../src/webhooks/payments-gate.utils';

assert.deepEqual(
  getWebhookOrderCandidates({ object: { uuid: 'txn_123' } }),
  ['txn_123'],
  'should accept uuid as a valid order identifier when external_id is absent',
);

assert.deepEqual(
  getWebhookOrderCandidates({ object: { uuid: 'txn_123', external_id: 'deal_456' } }),
  ['deal_456', 'txn_123'],
  'should prefer external_id and keep uuid as fallback',
);

console.log('webhook-order-match test passed');
