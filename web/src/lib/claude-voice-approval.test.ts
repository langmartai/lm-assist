import { describe, it, expect } from 'vitest';
import { buildApprovalFrame, buildDenyFrame } from './claude-voice-approval';

describe('buildApprovalFrame', () => {
  it('builds an approve frame — is_approved:true, the chosen option, no type field', () => {
    const frame = buildApprovalFrame('toolu_1', 'appr_abc', 'once');
    expect(frame).toEqual({ tool_use_id: 'toolu_1', is_approved: true, approval_key: 'appr_abc', approval_option: 'once' });
    expect(frame).not.toHaveProperty('type');
  });

  it.each(['once', 'perChat', 'always'] as const)('carries the %s option verbatim', (option) => {
    const frame = buildApprovalFrame('toolu_1', 'appr_abc', option);
    expect(frame.approval_option).toBe(option);
  });
});

describe('buildDenyFrame', () => {
  it('builds a deny frame — is_approved:false, no approval_option, no type field', () => {
    const frame = buildDenyFrame('toolu_2', 'appr_xyz');
    expect(frame).toEqual({ tool_use_id: 'toolu_2', is_approved: false, approval_key: 'appr_xyz' });
    expect(frame).not.toHaveProperty('type');
    expect(frame).not.toHaveProperty('approval_option');
  });
});
