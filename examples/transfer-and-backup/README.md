# Cross-node file transfer & Claude Code session backup

Two utilities that treat your fleet's data as one estate: move any file or directory between
machines with a durable, resumable job — and capture every host's Claude state into one
searchable backup store.

## Cross-node transfer

Moving data is a sentence, not a command:

> **You:** what's in the exports folder on my windows-desk? I don't want to overwrite anything
>
> **Claude:** *(lm-assist → transfer_list_remote)* `C:\exports` on **windows-desk** has six entries: three CSVs from last week (about 40 MB each), a `reports\` directory, and two zip archives. Nothing named like the dataset you're about to send.

> **You:** ok, send ~/datasets/train.tar.zst from the linux-box over there
>
> **Claude:** *(lm-assist → transfer_send_file)* Enqueued durable job **tj_a91f42**: 3.2 GB from **linux-box** to **windows-desk** at `C:\exports\train.tar.zst`. The nodes negotiated a direct UDP path, so it's skipping the hub. Ask me anytime — the job survives drops and restarts.

> **You:** done yet?
>
> **Claude:** *(lm-assist → transfer_status)* Done. 3.2 GB in 48 s over the direct path (mode `bidi`, via `host`), integrity verified end to end. There was one brief peer drop mid-way — it resumed from the last checkpoint instead of restarting.

Tools involved: `transfer_send_file`, `transfer_queue`, `transfer_status`, `transfer_cancel`, `transfer_stats`, `port_forward_stats`, `transfer_list_remote`

Jobs **survive peer drops and Core restarts**, auto-retry, and large single files resume from
the last checkpoint — a multi-GB transfer interrupted mid-way continues rather than restarting.
Direct node-to-node port-forward transport bypasses the hub when possible (~4× faster). The
tool's own registry entry tells the story:

![transfer_send_file in the MCP tool registry](./mcp-tools-transfer.png)

## Claude Code session backup

The backup system captures **every host's `~/.claude`** — sessions, memory, rules — plus your
claude.ai conversations into one store on the fleet's collector node, then makes it searchable
without unpacking anything:

> **You:** dry-run a backup pass first — I want to see what it would pick up
>
> **Claude:** *(lm-assist → backup_run)* Dry run across all targets, nothing written: a pass would capture 214 changed session files, 18 memory files, and 41 claude.ai conversations — roughly 380 MB of new data. Credentials are excluded at capture. Say the word and I'll run it for real.

> **You:** how healthy is the store overall?
>
> **Claude:** *(lm-assist → backup_status)* Three targets fresh (last runs within 12 hours), one aging — **windows-desk** hasn't completed a pass in 3 days. Index is current, 68 GB free on the store disk, no credential files flagged.

> **You:** what did that session last month say about the retry backoff?
>
> **Claude:** *(lm-assist → backup_search, backup_read)* Top hit is a session snapshot from August 7 on **laptop**: "widened the retry backoff to 5/5/10 minutes and capped it at 30." I pulled the surrounding turns straight out of the snapshot — the rest of the session is there if you want it.

Tools involved: `backup_run`, `backup_status`, `backup_list`, `backup_search`, `backup_read`

Notes:
- Only the node holding the store root is the collector; calls from elsewhere return a pointer
  telling you which `node:` to pass — routing is one argument, not a diagnosis.
- Snapshots retain history per target, so "what did that session say last month" survives local
  cleanup — this is also what powers
  [full claude.ai conversation search](../claudeai-conversation-search/).
