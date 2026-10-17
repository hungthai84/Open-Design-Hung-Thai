/** A queued request is accepted only once its execution start is observed. */
export function createRunStartReceipt(signals: readonly AbortSignal[]) {
  let finished = false;
  let resolve!: (started: boolean) => void;
  const started = new Promise<boolean>((done) => { resolve = done; });
  const settle = (accepted: boolean) => {
    if (finished) return;
    finished = true;
    for (const signal of signals) signal.removeEventListener('abort', abort);
    resolve(accepted);
  };
  const abort = () => settle(false);
  for (const signal of signals) {
    if (signal.aborted) { settle(false); break; }
    signal.addEventListener('abort', abort, { once: true });
  }
  return { started, settle };
}
