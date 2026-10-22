import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config.ts';
const output = process.env.OD_FUNDING_EVIDENCE_DIR;
if (!output) throw new Error('Fresh evidence directory required');
export default defineConfig({ ...base, testDir: fileURLToPath(new URL('../../ui', import.meta.url)), testMatch: 'workspace-f14-sandbox.test.ts', testIgnore: [], workers: 1, fullyParallel: false, retries: 0, maxFailures: 1, outputDir: `${output}/playwright`, reporter: [['list'], ['json', { outputFile: `${output}/results.private.json` }]], use: { ...base.use, viewport: { width: 1440, height: 961 }, colorScheme: 'light', trace: 'on', screenshot: 'only-on-failure' } });
