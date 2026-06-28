import { test, expect } from 'vitest';
import { getHubDomain } from '../utils';

// getHubDomain decides which hub the /lan-blocked "Sign In" popup authenticates
// against (surfaced via /api/server.hubDomain). It must map each fleet's wss hub
// URL to the right sign-in domain and never throw.
test('getHubDomain — langmart hub wss URL → langmart.ai', () => {
  expect(getHubDomain('wss://assist-api.langmart.ai')).toBe('langmart.ai');
});

test('getHubDomain — xeenhub (dev) hub wss URL → xeenhub.com', () => {
  expect(getHubDomain('wss://assist-api.xeenhub.com')).toBe('xeenhub.com');
});

test('getHubDomain — https form is also recognized', () => {
  expect(getHubDomain('https://assist-api.xeenhub.com/mcp')).toBe('xeenhub.com');
});

test('getHubDomain — missing/unknown/garbage falls back to langmart.ai', () => {
  expect(getHubDomain(null)).toBe('langmart.ai');
  expect(getHubDomain(undefined)).toBe('langmart.ai');
  expect(getHubDomain('not a url')).toBe('langmart.ai');
  expect(getHubDomain('wss://assist-api.example.com')).toBe('langmart.ai');
});
