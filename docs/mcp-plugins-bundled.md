# Bundled ext plugins — first-party plugins that ship inside the package

**Audience: lm-assist maintainers.** Third-party plugin authors want
[`mcp-plugin-contract.md`](mcp-plugin-contract.md) instead — that contract is unchanged and
still describes how *their* plugin reaches a node. Nothing here loosens it.

## The problem this solves

Before this, every ext plugin reached a node by a **human `cp`** from the plugin's own repo,
followed by two loopback `curl`s. That is right for a third-party plugin and wrong for a
first-party one: `langmart-design` is our code, talking to our gateway, using a key the node
already holds, and it was still absent from every fresh node until somebody remembered the
runbook. It is the pane-shim split all over again (see [ui-panes-deploy](ui-panes-deploy.md)):
the server rides the build, the payload rides a person, and the mismatch surfaces late.

A bundled plugin travels **in the same npm tarball as Core**, and Core installs it on boot.

## 🔴 A bundled payload is a MIRROR, not a source

Everything under `core/data/mcp-plugins/<name>/` is a copy of a plugin **maintained in another
repository**, and that repository may be **private** while this one is public and
AGPL-3.0-or-later. Three consequences that are easy to get wrong:

1. **Never edit the copy.** Changing `core/data/mcp-plugins/<name>/` forks a repo this one does
   not own, and the next re-vendor silently overwrites it. Edit upstream, then re-vendor.
2. **Vendoring is a publishing decision, not a build step.** Mirroring a payload here puts it in
   a public repo and on npm under this repo's licence. Before adding a plugin, confirm its owner
   intends it to be published — and that it carries no credential, no internal host, and no
   endpoint you would not document publicly. Grants are always derived on the node
   (see below), so a payload never needs to contain a secret; if one seems to, that is the bug.
3. 🔴 **Never name the upstream.** A private repository's URL, name, owner account or author
   email is itself disclosure, and everything here reaches everyone who installs lm-assist —
   `bundled.json`, the payload's own `mcp-plugin.json` (`author`, `homepage`), this file, and any
   route response, which is readable through the hub relay. Scrub it at the **source**: the
   upstream's manifest generator is what stamps `author`/`homepage`, so fix it there and
   re-vendor. `bundled.json` therefore records a mirror's **checksum and nothing else**, and
   `/mcp-plugins` exposes a boolean `bundledMirror`, never an identity.

The mirror rule is enforced rather than trusted: each entry in `bundled.json` records the
**upstream payload checksum** it was vendored from, and `gen-bundled-plugins.js` refuses to
reindex a mirror whose files no longer match it. The unit test additionally asserts that the
recorded provenance is a bare `checksum`, so a future change cannot quietly reintroduce a repo
URL into a published file.

## The trust argument — and its exact limits

Contract §2 makes enabling a loopback-only human action because enabling authorises
**third-party** code execution. A bundled payload differs in one way that matters: it arrived
in the same artifact as `core/dist`, which needs no approval at all. A second consent prompt
for code the operator already installed buys no security — it only guarantees the plugin is
dead on every fresh node until someone clicks.

So what does the checksum in `bundled.json` actually buy? Exactly one thing, and this is the
whole claim:

> A plugin directory auto-enables **only while it is byte-for-byte the payload this build
> shipped.**

That is the case the pin was built for: a locally edited tree never inherits package trust and
falls back to the normal human gate. It is **not** a defence against a tampered tarball — an
attacker who can rewrite the payload can rewrite `core/dist` too. Do not describe it as one.

Two hashes are pinned, not one, because `payloadChecksum()` deliberately **excludes**
`mcp-plugin.json` (it carries the field and cannot hash itself). The manifest is the review
surface that declares `capabilities` — leaving it unpinned would make the declared network and
env access the one part of the package nothing covers. So `bundled.json` carries both
`checksum` (payload) and `manifestDigest`, and a version bump or a widened `capabilities.env`
moves the second even when the first is unchanged.

## What is automatic, and what is not

| | behaviour |
|---|---|
| fresh node | payload copied in, declared env derived from local config, **auto-enabled** |
| reboot, nothing changed | `up-to-date` — no writes, no connector sync, no log noise |
| package ships a new version | the tree **we** seeded is replaced and re-pinned |
| owner edited the installed tree | `kept-local` — never overwritten, never auto-enabled |
| a plugin someone hand-installed under the same name | `kept-local` — untouched |
| a tree already present that is **byte-identical** to the package's | adopted and enabled — the rule is about the bytes, not about who put them there |
| owner ran `POST /mcp-plugins/<name>/disable` | stays off **across upgrades** (`bundledOptOut`) |
| `bundled.json` disagrees with the shipped bytes | the whole plugin is refused, loudly |
| `LM_BUNDLED_PLUGINS=0` | seeding off; hand-installed plugins unaffected |
| `LM_MCP_PLUGINS=0` | the whole subsystem off, as before |

Auto-enable is also skipped when a declared env name cannot be filled — a plugin that spawns
and then fails every call is worse than one that is honestly off, so the result says which
grant is missing.

## Grants are derived, never shipped

**No secret is ever written into the package.** A bundled plugin that needs credentials gets a
*grant provider* in `bundled.ts`, keyed by plugin name, which derives values from config the
node already holds. A value a human granted always outranks a derived one.

`langmart-design`'s provider reads `~/.lm-assist/hub.json`:

| grant | derived from | note |
|---|---|---|
| `LANGMART_API_KEY` | `apiKey` | the `sk-langassist-…` hub key |
| `LANGMART_API_BASE` | `hubUrl`, `assist-api.<domain>` → `https://api.<domain>` | keeps dev/prod self-selecting |

The hub key works on the gateway's public `/api/*` because it is an ordinary row in the same
`api_keys` table as a user's `sk-langmart-…` key — same user, same org, `key_kind` NULL, so
`authenticate()` accepts it and `requireNotMcpToken` does not 403 it. Verified live against
`api.langmart.ai`, not inferred from the shape of the string.

🔴 That key is **read+write** at the gateway, which does not enforce per-key scoping
(`api_keys.permissions` is dead). Read-only is a property of the **plugin**, which hardcodes
`method: 'GET'`. Do not weaken that on the assumption the key is limited.

An unrecognised hub host yields **no** base URL rather than a guess — a wrong base would send
the node's key to a host nobody reviewed — and a half-derived grant is dropped entirely.

## Adding or updating a bundled plugin

Work **upstream**, never in `core/data/`:

```bash
# 1. edit the plugin IN ITS OWN REPO, then re-stamp + test it there
#      node mcp-plugins/tools/gen-manifest.js && node mcp-plugins/test/selftest.js

# 2. re-vendor into lm-assist (copies the payload AND records its upstream checksum)
./core.sh build                                    # the script reuses the loader's checksum
node core/scripts/gen-bundled-plugins.js --from <upstream-repo>/mcp-plugins

# 3. see what a node would do, without touching it
./core.sh plugins check

# 4. Core also does this on every boot; run it now if you want it now
./core.sh plugins sync
```

A plain `node core/scripts/gen-bundled-plugins.js` (no `--from`) only **verifies and reindexes**
— it is the command that catches a hand-edited mirror. `--check` makes it a CI gate.

`gen-bundled-plugins.js` refuses to write an index in three cases, each with its own message:
the upstream payload's own `mcp-plugin.json.checksum` disagrees (the upstream repo's
`gen-manifest.js` was not re-run); a vendored payload disagrees with its manifest; or a mirror
no longer matches the upstream checksum it was vendored from.

🔴 **Forgetting step 2 does not fail quietly.** `seedBundledPlugins()` refuses any plugin whose
shipped bytes disagree with the index, because seeding a tree whose "trusted" checksum was never
true is worse than seeding nothing. The unit test `the SHIPPED index matches the payloads
actually vendored in this build` catches it before it leaves the repo.

## Where it lives

| path | role |
|---|---|
| `core/data/mcp-plugins/<name>/` | the mirrored payload (shipped via `files: ["core/data"]`) |
| `core/data/mcp-plugins/README.md` | the do-not-edit notice that sits next to the mirrors |
| `core/data/mcp-plugins/bundled.json` | the index: name, version, payload checksum, manifest digest, upstream provenance |
| `core/src/mcp-server/plugins/bundled.ts` | seed + derive grants + trust |
| `core/scripts/gen-bundled-plugins.js` | regenerate the index |
| `core/scripts/sync-bundled-plugins.js` | `core.sh plugins check\|sync` |
| `rest-server.ts` → `seedBundledPlugins()` | the boot hook |

State lives where all plugin state lives — `~/.lm-assist/mcp-plugin-state[-dev].json`, 0600,
outside every plugin directory, with two added fields (`bundledSeededChecksum`,
`bundledSeededManifestDigest`) recording what this node last seeded.

## Operational notes

- **The connector is only re-synced when the tool surface actually changed.** A quiet boot must
  not poke the live claude.ai account. A `core.sh plugins sync` that enables something happens
  outside the enable route, so it tells you to restart Core or `POST /mcp-plugins/sync-connector`.
- **Provenance is visible, identity is not.** State records `enabledBy: bundled@<version>`, and
  `/mcp-tools` badges it `trusted by package` — never as an owner approval. A mirrored plugin
  badges `bundled mirror` and its detail pane says to edit it in its own repo, without naming
  that repo. A drifted tree badges `locally modified`.
- **Dev and prod stay separate**, as everywhere else: a repo build seeds `mcp-plugins-dev/` and
  reads `hub-dev.json`; an npm install seeds `mcp-plugins/` and reads `hub.json`.
