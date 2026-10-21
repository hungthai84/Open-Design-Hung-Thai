import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import {
  readFundingRuntimeFixture,
  type FundingRuntimeFixture,
  type FundingSpace,
} from './workspace-funding-fixture.ts';

type Wallet = {
  actor: FundingRuntimeFixture['actor'];
  space: FundingSpace & { workspaceName: string };
  deviceRuntimeKey: string;
  initialBalanceUsd: '0.00' | '2.00';
};
export type RecoveryFixture = FundingRuntimeFixture & {
  recovery: {
    attemptId: string;
    wallets: Record<'a' | 'b', Wallet>;
    proofPath: string;
    proofSha256: string;
    serverDirectory: string;
    recharge: { helperPath: string; helperSha256: string; sourceSha: string; repoPath: string };
    backendObservationPath: string;
    concurrencyObservationPath: string;
    provider: { statePath: string; pid: number; sourceSha256: string };
  };
};
export async function readRecoveryFixture(): Promise<RecoveryFixture> {
  const base = await readFundingRuntimeFixture();
  const fixture = JSON.parse(
    await readFile(process.env.OD_FUNDING_FIXTURE!, 'utf8'),
  ) as RecoveryFixture;
  const given = fixture.recovery;
  if (
    !given ||
    !isAbsolute(given.serverDirectory) ||
    !isAbsolute(given.proofPath) ||
    !/^[a-f0-9]{64}$/.test(given.proofSha256) ||
    !/^[a-f0-9-]{36}$/.test(given.attemptId)
  )
    throw Error('Explicit RUN010 fixture required');
  if ((await stat(given.proofPath)).mode & 0o077) throw Error('Private original Given required');
  const proofBytes = await readFile(given.proofPath);
  if (createHash('sha256').update(proofBytes).digest('hex') !== given.proofSha256)
    throw Error('Original RUN010 Given changed');
  const proof = JSON.parse(proofBytes.toString());
  if (proof.tuple.amr !== base.upstream.amrSha) throw Error('RUN010 product mismatch');
  for (const alias of ['a', 'b'] as const) {
    const wallet = given.wallets[alias];
    const original = proof.wallets[alias];
    if (
      !wallet ||
      wallet.space.actorRole !== 'owner' ||
      wallet.space.actorMemberId !== wallet.space.ownerMemberId ||
      !wallet.space.workspaceName.startsWith(base.isolation.workspaceNamePrefix) ||
      wallet.space.workspaceId !== original.space.workspaceId ||
      wallet.actor.userId !== original.actor.userId ||
      wallet.actor.controlKey !== original.actor.controlKey ||
      wallet.space.runtimeKey !== original.space.runtimeKey ||
      wallet.deviceRuntimeKey !== original.deviceRuntimeKey ||
      original.deviceAuth.runtimeKeySource !== 'cli_device' ||
      createHash('sha256').update(wallet.deviceRuntimeKey).digest('hex') !==
        original.deviceAuth.runtimeKeySha256 ||
      wallet.initialBalanceUsd !== (alias === 'a' ? '0.00' : '2.00')
    )
      throw Error('RUN010 must retain the two actual Owner/space/DeviceAuth Givens');
  }
  if (
    given.wallets.a.actor.userId === given.wallets.b.actor.userId ||
    given.wallets.a.space.workspaceId === given.wallets.b.space.workspaceId
  )
    throw Error('Separate paid Owners and spaces required');
  const helper = given.recharge;
  if (
    !isAbsolute(helper.helperPath) ||
    !/^[a-f0-9]{64}$/.test(helper.helperSha256) ||
    !/^[a-f0-9]{40}$/.test(helper.sourceSha) ||
    !/^services\/api\/test\/e2e\/[a-z0-9-]+\.ts$/.test(helper.repoPath)
  )
    throw Error('Explicit server action source required');
  const raw = await readFile(helper.helperPath);
  const blob = await promisify(execFile)(
    'git',
    ['show', `${helper.sourceSha}:${helper.repoPath}`],
    { cwd: base.owner.sourceRoot, encoding: 'buffer' },
  );
  if (
    createHash('sha256').update(raw).digest('hex') !== helper.helperSha256 ||
    !raw.equals(blob.stdout)
  )
    throw Error('Recharge action differs from committed reviewed source');
  return { ...base, recovery: given };
}
