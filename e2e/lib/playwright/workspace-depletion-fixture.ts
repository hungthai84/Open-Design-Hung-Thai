import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  readFundingRuntimeFixture,
  type FundingRuntimeFixture,
  type FundingSpace,
} from './workspace-funding-fixture.ts';
export type DepletionFixture = FundingRuntimeFixture & {
  depletion: {
    space: FundingSpace & { workspaceName: string };
    deviceRuntimeKey: string;
    attemptId: string;
    initialBalanceUsd: string;
    proofPath: string;
    proofSha256: string;
    backendObservationPath: string;
    provider: {
      baseUrl: string;
      statePath: string;
      sourcePath: string;
      sourceSha256: string;
      sourceCommit: string;
      sourceRepoPath: string;
      pid: number;
    };
  };
};
export async function readDepletionFixture(): Promise<DepletionFixture> {
  const base = await readFundingRuntimeFixture();
  const path = process.env.OD_FUNDING_FIXTURE;
  if (!path) throw Error('Explicit RUN005 fixture required');
  const raw = JSON.parse(await readFile(path, 'utf8')) as DepletionFixture;
  const given = raw.depletion;
  if (
    !given ||
    !given.space ||
    given.space.actorRole !== 'owner' ||
    given.space.actorMemberId !== given.space.ownerMemberId ||
    !given.space.workspaceId ||
    !given.space.workspaceName.startsWith(base.isolation.workspaceNamePrefix) ||
    !given.space.runtimeKey ||
    !given.deviceRuntimeKey ||
    given.initialBalanceUsd !== '2.00' ||
    !isAbsolute(given.backendObservationPath) ||
    !isAbsolute(given.proofPath) ||
    !/^[a-f0-9]{64}$/.test(given.proofSha256)
  )
    throw Error(
      'RUN005 requires the explicitly scoped real DeviceAuth Owner and initial wallet proof',
    );
  if ((await stat(given.proofPath)).mode & 0o077) throw Error('RUN005 proof must be private');
  const bytes = await readFile(given.proofPath);
  if (createHash('sha256').update(bytes).digest('hex') !== given.proofSha256)
    throw Error('RUN005 proof changed');
  return { ...base, depletion: given };
}
