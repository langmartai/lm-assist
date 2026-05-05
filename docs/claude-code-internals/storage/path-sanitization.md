# Path Sanitization

Source: `utils/sessionStoragePortable.ts`

## Algorithm

```typescript
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  // Long paths get truncated + hash suffix
  const hash = typeof Bun !== 'undefined'
    ? Bun.hash(name).toString(36)   // Bun runtime
    : simpleHash(name)               // Node.js fallback (djb2)
  return `${sanitized.slice(0, 200)}-${hash}`
}
```

## Examples

| Input Path | Sanitized |
|-----------|-----------|
| `/home/ubuntu/project` | `-home-ubuntu-project` |
| `C:\Users\yi\code` | `C--Users-yi-code` |
| `/very/long/path/.../over200chars` | `-very-long-path-...-{hash}` |

## Hash Mismatch Problem

Bun.hash and djb2Hash produce **different hashes** for the same string. The CLI (Bun) and SDK (Node.js) create different directory names for paths > 200 chars.

`findProjectDir()` handles this with prefix-based fallback:
```typescript
// Exact match failed for long path → scan for prefix match
const prefix = sanitized.slice(0, 200)
const match = dirents.find(d => d.name.startsWith(prefix + '-'))
```

## lm-assist Compatibility

lm-assist supports two decoding modes:
- **Legacy (dash-replacement)**: `/home/ubuntu/project` ↔ `-home-ubuntu-project`
- **New (Base64)**: URL-safe Base64 encoding (no padding)

Ambiguity: `-home-ubuntu-sample-project` could be `/home/ubuntu/sample-project` or `/home/ubuntu/sample/project`. Resolved via filesystem existence checks.

## Path Canonicalization

```typescript
async function canonicalizePath(dir: string): Promise<string> {
  return (await realpath(dir)).normalize('NFC')
}
```

NFC normalization ensures consistent Unicode representation (critical for macOS where paths may be NFD).

Git root is canonicalized so **all worktrees share one memory directory**.
