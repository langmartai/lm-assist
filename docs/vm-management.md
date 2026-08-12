# VM management — Hyper-V (Windows) / KVM-libvirt (Linux)

Fleet-wide virtual-machine management: a common API (`/vm/*` routes) with per-platform
backends, surfaced as 5 MCP tools. Follows the desktop-automation backend-split
(`types.ts` / `config.ts` / `service.ts` / per-platform backend) and the gmail
config/backend separation.

## Where things live

```
core/src/vm/
├── types.ts           ← cross-platform contract: VmBackend interface, VmInfo, VmCreateSpec,
│                        VmError + VmErrorCode (VM_NOT_FOUND, VM_NOT_MANAGED, UNSAFE_PATH, …)
├── config.ts          ← deployment facts ONLY: storage root, elevation mode, limits, timeouts.
│                        Read PER CALL (env > <dataDir>/vm[-dev].json > default) — config
│                        changes apply without a restart.
├── service.ts         ← THE single import surface. Validation, managed-VM gate, bounded
│                        single-flight write mutex. Routes + MCP tools import from here only.
├── hyperv-backend.ts  ← win32: PowerShell Hyper-V cmdlets
└── kvm-backend.ts     ← linux: virsh/qemu-img (e2e-verified on 117, 2026-08-12)

core/src/routes/core/vm.routes.ts   ← GET /vm/status|list|config|snapshots,
                                      POST /vm/create|start|stop|delete|snapshot, PUT /vm/config
core/src/mcp-server/tools/vm.ts     ← 5 MCP tools (loopback passthroughs to the routes)
core/src/__tests__/vm-service-validation.test.ts
```

## MCP tools (all carry the fleet `node` selector automatically)

| tool | scope | what |
|---|---|---|
| `vm_status` | read | backend doctor + bounded inventory `{vms,total,truncated}`; `name=` → one VM's detail. There is deliberately NO `vm_list` — status absorbs it (catalogue byte budget). |
| `vm_create` | write | create under `<storageRoot>/<name>/`, tagged `[lm-assist]` in Notes |
| `vm_power` | write | `action:start\|stop`; stop graceful by default, `force:true` = hard off |
| `vm_snapshot` | write | `action:list\|create\|restore\|delete`; create auto-names `lm-<iso-ts>` |
| `vm_delete` | admin | power off + unregister + delete disks (only under the storage root) |

## Rules that bite

- **Security boundary is the input charset, not escaping.** `VM_NAME_RE`
  `/^[A-Za-z0-9._-]{1,64}$/` makes names embeddable single-quoted in privileged commands;
  paths are charset-checked (no quotes/backticks/`$`/newlines) and `..` is rejected on the
  RAW input (path.resolve silently normalizes it away — check before resolving). Notes are
  sanitized (straight quotes → typographic). Widening any of these regexes IS widening what
  can reach an elevated shell.
- **All Windows PowerShell ships as `-EncodedCommand`** (base64 UTF-16LE) on BOTH the
  direct-spawn and elevated-worker paths. The worker's `shell:'powershell'` mode naively
  joins args into a `-Command` string — never send raw script through it.
- **Elevation modes** (`elevation` in `<dataDir>/vm[-dev].json`): `auto` (direct, fall back
  to the :3110 elevated worker when stderr matches DENIED_RE) · `always` · `never`. Linux:
  root / direct (libvirt group) / `sudo -n`. KVM always uses `virsh -c qemu:///system` —
  bare non-root virsh silently hits `qemu:///session` (split-brain inventory). ⚠ A `direct`
  privilege only proves VIRSH access — filesystem helpers (mkdir/rm on the root-owned storage
  tree) fall back to `sudo -n` on EACCES (found live on the first KVM e2e).
- **Managed-VM gate:** delete / snapshot-restore / snapshot-delete refuse a VM lm-assist
  did not create (no `[lm-assist]` tag) unless `force:true`. Disk deletion only ever touches
  files UNDER the storage root — containment is decided in TS (case-insensitive on Windows),
  never by the hypervisor.
- **Storage root is explicit:** default `C:\lm-vms` (win) / `/var/lib/lm-vms` (linux);
  override via env `LM_VM_STORAGE_ROOT` or config. On host 107 it is `C:\lm-vms`.
- **Registration:** a vm tool lives in FOUR places — `tools/vm.ts`, `expanded.ts`,
  `TOOL_SCOPES` in `configure.ts` (missing scope CRASHES Core on tools/list), and
  `registry/catalog.ts`. Run the mcp-tool-catalog + scope tests, not just the vm test.
- **Catalogue budget:** ~291 KB vs the 295 KB budget (~4 KB headroom) after the 2026-08-12
  re-trim of the shared `NODE_PARAM` string (each byte there costs ~280 on the wire — trim
  shared boilerplate first, per-tool prose second, and only raise the budget deliberately).
- **Timeouts:** every backend timeout is held under `workerPostRaw`'s fixed 120 s loopback
  ceiling (create/delete/snapshot 100 s, start 90 s, stop ≤110 s). A hub-relayed connector
  call is cut at ~25–30 s — long ops still complete server-side; poll `vm_status`.

## E2E — both backends verified

**Hyper-V (2026-08-05, host 107):** full lifecycle through the MCP surface (StreamableHTTP
`/mcp`, sandboxed Core on :3210): create (512 MB gen-2, disk under `C:\lm-vms`) → start →
status running → snapshot create/list/delete → config flip `{"elevation":"always"}` mid-run
proved the elevated-worker path (`privilege:"worker"`, no restart needed) → force stop →
delete with disks → inventory + filesystem absence.

**KVM/libvirt (2026-08-12, node 117 — Ubuntu 22.04, libvirt 8.0.0, nested KVM):** same
lifecycle, privilege `direct` + sudo filesystem fallback, thin qcow2 under `/var/lib/lm-vms`.
⚠ Linux fleet nodes are themselves VMs — keep nested test guests TINY (≤512 MB RAM, ≤2 GB
thin disk) so they cannot pressure the parent VM's memory/disk.
