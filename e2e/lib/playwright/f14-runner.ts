import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFundingRuntimeFixture } from './workspace-funding-fixture.ts';
import { verifyFundingLease, withFundingLease } from './workspace-funding-lease.ts';
import { runFundingCommand } from './funding-runner.ts';
async function main() {
  const fixture = await readFundingRuntimeFixture(); const output = process.env.OD_FUNDING_EVIDENCE_DIR;
  if (!output || !isAbsolute(output)) throw new Error('Fresh absolute evidence directory required');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const receipts: unknown[] = []; let childExit: number | null = null;
  try { await withFundingLease(async phase => { const checked = await verifyFundingLease(fixture, phase === 'pre' ? 720000 : 0); receipts.push({ phase, ...checked.safe }); }, async () => {
    const verified = await verifyFundingLease(fixture, 720000); const root = fileURLToPath(new URL('../..', import.meta.url));
    const paths = ['lib/playwright/f14-runner.ts', 'lib/playwright/f14.config.ts', 'lib/playwright/funding-runner.ts', 'lib/playwright/workspace-funding-client.ts', 'lib/playwright/workspace-funding-fixture.ts', 'lib/playwright/workspace-funding-lease.ts', 'ui/workspace-f14-sandbox.test.ts'];
    receipts.push({ sources: await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') }))) });
    const result = await runFundingCommand(['pnpm', 'exec', 'playwright', 'test', '-c', 'lib/playwright/f14.config.ts'], root, { ...process.env, ...verified.env, OD_FUNDING_OWNER_RUNNER: 'active' }, join(output, 'playwright.private.log')); childExit = result.exitCode; receipts.push(result);
  }); } finally { await writeFile(join(output, 'ownership.safe.json'), JSON.stringify({ receipts, childExit, wholeQaCasesPassed: 0 }, null, 2), { mode: 0o600 }); }
  if (childExit !== 0) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`F14 first pass stopped: ${String(error)}\n`); process.exitCode = 1; });
