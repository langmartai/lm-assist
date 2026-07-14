import { describe, it, expect } from 'vitest';
import { speechText } from './speech';

describe('speechText', () => {
  it('replaces fenced code blocks with a short placeholder', () => {
    expect(speechText('before\n```js\nconst x = 1\n```\nafter')).toBe('before . code block. after');
  });
  it('unwraps inline code and link text', () => {
    expect(speechText('use `foo()` see [docs](http://example.com)')).toBe('use foo() see docs');
  });
  it('strips markdown punctuation and collapses whitespace', () => {
    expect(speechText('# Head\n- **bold** _italic_')).toBe('Head - bold italic');
  });
  it('is a no-op on plain prose', () => {
    expect(speechText('The capital of France is Paris.')).toBe('The capital of France is Paris.');
  });
});
