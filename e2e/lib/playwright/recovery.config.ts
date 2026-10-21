import base from './funding.config.ts';

export default {
  ...base,
  testMatch: 'workspace-recovery-sandbox.test.ts',
  ...(process.env.OD_RECOVERY_GROUP
    ? { grep: new RegExp(`group ${process.env.OD_RECOVERY_GROUP}`) }
    : {}),
};
