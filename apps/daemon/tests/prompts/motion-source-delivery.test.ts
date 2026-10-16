import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { composeSystemPrompt as composeApiPrompt } from '@open-design/contracts';

describe('assembled video motion source instructions', () => {
  it.each([['daemon', composeSystemPrompt], ['API', composeApiPrompt]] as const)('%s keeps editable video sources visible and distinguishes legacy HyperFrames', (_name, compose) => {
    const prompt = compose({ skillMode: 'video', metadata: { kind: 'video', videoModel: 'hyperframes-html' } });
    expect(prompt).toContain('motion-source/<id>');
    expect(prompt).toContain('Legacy HyperFrames');
    expect(prompt).not.toContain('COMP_REL=".hyperframes-cache/');
    expect(prompt).not.toContain('under `.hyperframes-cache/`');
  });
});
