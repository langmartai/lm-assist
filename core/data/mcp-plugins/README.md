# Bundled MCP plugins — mirrors, not sources

Every subdirectory here is a **third-party MCP plugin** (contract: `docs/mcp-plugin-contract.md`)
that is **maintained in its own repository**. lm-assist carries a copy so the plugin can travel
inside the package and be installed on a node automatically — see `docs/mcp-plugins-bundled.md`.

## 🔴 Do not edit anything in these directories

These are **mirrors**. The upstream repo is the source of truth; a change made here is a silent
fork of code this repo does not own, and it will be overwritten by the next re-vendor.

**To change a plugin:**

1. Edit it in **its own repo**.
2. Run that repo's `gen-manifest.js` (regenerates `tools[]`, `version` and the payload checksum).
3. Run its self-test.
4. Re-vendor here, from the lm-assist repo root:

   ```bash
   ./core.sh build     # the vendoring script reuses the loader's checksum implementation
   node core/scripts/gen-bundled-plugins.js --from <upstream-repo>/mcp-plugins
   ```

This is enforced, not just requested: `bundled.json` records the upstream payload checksum each
mirror was vendored from, and `gen-bundled-plugins.js` **fails** when the files here no longer
match it.

## What ships here

| plugin | notes |
|---|---|
| `langmart-design` | 30 read-only tools forwarding to the LangMart public gateway API. Authored by the LangMart team and mirrored here for distribution; grants are derived on the node, so no credential is ever stored in this directory. |

`bundled.json` is generated — never hand-edit it either. It records each mirror's upstream
**checksum and nothing else**: this repo is public and an upstream may not be, so the index
deliberately does not name the repository a payload came from. An entry with no `upstream`
field would be a plugin lm-assist itself owns; there is currently no such plugin.

If you maintain one of these plugins you already know where its source lives. If you do not,
that is the point — open an issue rather than editing the copy.
