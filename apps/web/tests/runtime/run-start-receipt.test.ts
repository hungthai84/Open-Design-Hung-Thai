import { describe, expect, it } from 'vitest';
import { createRunStartReceipt } from '../../src/runtime/run-start-receipt';

describe('execution start receipt', () => {
  it('does not accept queueing and accepts one actual start', async () => {
    const receipt = createRunStartReceipt([]);
    let settled = false;
    void receipt.started.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    receipt.settle(true);
    receipt.settle(false);
    await expect(receipt.started).resolves.toBe(true);
  });
  it.each(['cancel', 'disconnect'] as const)('preserves rejection after %s even if an old start arrives', async (kind) => {
    const controller = new AbortController();
    const receipt = createRunStartReceipt([controller.signal]);
    if (kind === 'cancel') controller.abort();
    else receipt.settle(false);
    receipt.settle(true);
    await expect(receipt.started).resolves.toBe(false);
  });
  it('does not resurrect an already canceled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const receipt = createRunStartReceipt([controller.signal]);
    receipt.settle(true);
    await expect(receipt.started).resolves.toBe(false);
  });
});
