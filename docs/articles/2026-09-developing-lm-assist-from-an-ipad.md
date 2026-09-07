# From a terminal to an iPad: three months of lm-assist building itself

*A story from the lm-assist developer · September 2026*

**TL;DR** — Three months ago, developing lm-assist meant sitting at a PC or Mac with Claude Code
open in a terminal. Today about 99% of it happens from the Claude app on an iPad, and the last 1%
is a short list I can name. Nothing about the iPad changed. What changed is that every action that
used to need the PC — building, restarting, testing, driving and resuming sessions, taking
screenshots, moving files between machines, reviewing a pull request, cutting a release — became
an lm-assist MCP tool that Claude calls for me. lm-assist was built, for the most part, by Claude
Code sessions steered through lm-assist.

## Where lm-assist is today

lm-assist is a self-hosted control plane for the Claude product line: it sees and steers Claude
Code sessions (local, remote, and cloud), claude.ai conversations, Cowork, Agent SDK runs, memory
and rules, MCP connectors, and usage limits — across every machine you enroll — through a web
dashboard, a REST API, a Claude Code plugin, and an MCP connector that works from inside Claude
itself. The [README](../../README.md) has the map; the numbers below are from the repository's git
history as of this writing.

| | |
|---|---|
| First commit | 18 February 2026 |
| Commits on `main` | 2,039 — 1,606 of them in the last three months |
| Busiest months | June (783) and July (641): the build-out this story is about |
| Releases | 0.1.x through July; 0.2.0 → 0.2.4 in the first week of September (npm latest: 0.2.4) |
| MCP tools | 286 in the core registry; 385 offered on the connector once plugins are counted |
| Components tracked | 126 in the [registry](../components.md), 80 of them about Claude itself |
| Examples with real screenshots | 12, in [`examples/`](../../examples/README.md) |
| Doors | 4 — the MCP connector, the web dashboard, the Claude Code plugin, the REST API |

Of the four doors, the **MCP connector is the main one**: attach it to a claude.ai conversation, a
Cowork session, or a Claude Code session and Claude reaches every tool on every enrolled machine,
with the hub relaying each call over the node's own outbound connection. This whole story is about
that door.

## Three months ago

Early June 2026. The connector had landed in the last week of May and remote-session support on
3 June, so from the iPad I could *see* a Claude Code session running on my Linux box and read it.
Anything that *did* something still meant walking to the desk:

- a build and a restart of the dev Core after every change, then the test suite;
- typing into a session that was waiting for input, or resuming one that had hit the five-hour
  limit or died on a network failure overnight;
- copying a build to the other machines and restarting them;
- screenshots for the docs, taken by hand;
- the browser-side work — signing into Gmail or LinkedIn, checking a page, driving a tab;
- git and GitHub: a review, a merge, a release.

Multiply that by a few machines — Linux VMs, a Windows desktop — and the iPad was a viewer, not a
console.

## What had to exist

The build-out, dated from git history. Each row removed one reason to walk to the desk.

| When | What landed | What it removed |
|---|---|---|
| 27–31 May | the `/mcp` endpoint and the connector — lm-assist's tools inside claude.ai and the Claude app over the hub relay, with a full catalog and lm-assist-side authorization | the PC as the only place lm-assist could be *used* |
| 3–8 June | remote sessions (CCR): load, mirror, and connect local sessions to claude.ai/code; node-to-node transport and cross-node file transfer (a direct path, relay as fallback); the first session-messaging drivers | the terminal as the only place a session lives; ssh and scp between machines |
| 19–20 June | session messaging with verified submit and honest tool results — type into any live session from anywhere (Claude Code queues input while busy, and that counts as delivered) | walking over to answer a prompt |
| late June | live sessions connect themselves to remote control; `session_footprints` — one fleet-wide snapshot of what every session occupies | "which machine was that on?" |
| 30 June – 3 July | WhatsApp over the Cloud API; LinkedIn over a real signed-in browser on a node, driven by tools | the messaging and browser tabs on the PC |
| 13 July | auto-resume covers network failures, not only stalls and the five-hour limit | babysitting overnight sessions |
| 14–17 July | machine-access profiles, the memory & rules workspace, the MCP tool registry (per-tool overrides and on/off), the CCR page | settings only reachable on the box |
| 20–21 July | the third-party plugin loader — any MCP stdio server on a node becomes `ext__<plugin>__<tool>`; the backlog graph — issues and ideas, fleet-synced, that sessions and missions work from | changing the Core to add a tool; the notes file on the desk |
| 22 July | model-limit fallback (a verified `/model` switch) and `ccr_restart` | a rate limit ending the day |
| 29 July | the Gmail connector (the same browser-on-a-node model); the fleet backup — every host's Claude state in one store, searchable without restoring | the mail tab; "is that session still on the old laptop?" |
| 5–7 August | desktop automation and VM tools; `ui_screenshot` and `desktop_screenshot` — a picture of any dashboard or window on any machine | taking screenshots by hand |
| 13–15 August | UI panes hosted on the gateway — every dashboard is a URL Claude can hand you mid-conversation | opening the dashboard on the PC |
| 1 September | 0.2.0 and 0.2.1: the scope rebase, the docs reorganisation, twelve example folders with real, masked screenshots, a community PR reviewed, hardened, and merged | — all of it run from the iPad |
| 5 September | a plugin built, enabled, and called from [one claude.ai prompt](../../examples/build-your-own-mcp-plugin/) with no human gate | the last terminal step in extending the MCP |

None of these was designed as "the iPad feature". Each was the next thing that made me stand up.

## A day from the iPad

The exchanges below are condensed from the last month's work. The data is illustrative; the tools
are the real ones, and every one of them is called the same way from the Claude app.

> **You:** what's my fleet doing?
>
> **Claude:** *(lm-assist → list_nodes, session_footprints)* Both nodes online. The Linux box has
> two live Claude Code sessions — one on the docs reorganisation, one idle since 04:10 waiting on a
> permission prompt. The Windows desktop is running the WhatsApp browser and nothing else.

> **You:** answer that prompt with "yes", then build and restart the dev Core on the linux box and
> run the core tests — tell me only what fails
>
> **Claude:** *(lm-assist → send_session_message, agent_execute, get_execution)* Delivered — the
> session picked it up and is moving. Build clean, restarted on the dev ports, 327 test files: one
> failure, the scheduler test that still asserts the old job name. Fix it in that session, or open
> a fresh one?

> **You:** the overnight session hit the 5-hour limit — is it handled?
>
> **Claude:** *(lm-assist → stall_status)* It was. The limit reset at 02:00 and auto-resume sent
> the continue forty seconds later; the session has done eleven more turns since. A network drop
> at 03:15 was retried the same way. Nothing for you to do.

> **You:** I need screenshots of the mission graph and of the WhatsApp page on the windows box for
> the docs — blur anything personal
>
> **Claude:** *(lm-assist → ui_screenshot, desktop_screenshot)* Two files under the examples folder
> on the Linux box; chat names and message previews are blurred at capture. The WhatsApp one shows
> the first chat opened, as you asked.

> **You:** there's a community PR on the repo — review and test it with a security focus in the
> background while we cut the release
>
> **Claude:** *(lm-assist → github_query, agent_execute)* The PR is checked out in a worktree on the
> Linux box and a review agent is on it. Meanwhile the three version files are bumped, the tarball
> is packed and grepped for anything that shouldn't ship, and the changelog is written. Publishing
> needs your npm login on that machine — that's the one step I can't do for you.

> **You:** give me the mission board
>
> **Claude:** *(lm-assist → ui_list)* Here's the live mission graph as a page — it opens on this
> iPad and stays live.

Tools involved: list_nodes, session_footprints, send_session_message, agent_execute, get_execution, stall_status, ui_screenshot, desktop_screenshot, github_query, ui_list

The screenshots in [`examples/`](../../examples/README.md) were taken exactly this way — by
sessions on machines I never sat in front of, with the personal content blurred before capture.

## The 99% — and the 1%

The honest remainder, the things that still need a hand on a machine:

- **Enrolling a brand-new machine.** The one-time keypack has to be typed on it once; after that
  it dials out to the hub and never needs me again.
- **The first sign-in** to a browser profile a service connector drives — Gmail, LinkedIn,
  WhatsApp. Password and 2FA happen once, on that machine; the profile persists.
- **Publishing to npm.** The registry wants my login and 2FA on the publishing machine. Everything
  around it — version bumps, packing, the leak check on the tarball, the changelog, the tag — is
  the session's job.
- **Anything physical.** A machine that is off, a cable, an elevation prompt nobody has granted yet.

Everything else, this month, was a sentence in the Claude app.

## Three decisions that made it possible

1. **Nodes only dial out; the hub relays.** Claude runs in the cloud and my machines have no inbound
   ports, so the hub serves the connector endpoint and relays every call over the node's own
   WebSocket. The consequence is that any device with the Claude app is a console — no VPN, no
   port forwarding, nothing installed on the iPad.
2. **Everything is a tool, and the tools are governed.** One `bootstrap` call teaches a session the
   whole surface; every tool is node-scoped, every result carries a provenance footer naming the
   hub, node, and cluster; access and auto-approval are per tool; the dangerous switches — enabling
   a plugin, machine access, cluster writes — are loopback-only. I can hand a chat the keys because
   the keys are scoped.
3. **The session keeps going when I put the iPad down.** Auto-resume after the five-hour limit and
   after network failures, a verified model fallback when a model is rate-limited, scheduled
   passes, and missions that drive sessions toward a goal. The work does not wait for me to come
   back.

## What it feels like

The iPad shows a chat. Behind it, sessions on machines I have not touched in weeks are building,
testing, screenshotting, and pushing. This page was written by one of those sessions — steered
from the Claude app — including the part where it fast-forwarded the repository, checked the
numbers above against git history, and pushed the result. If the number in the title looks like
marketing, that is the test: the article about developing lm-assist from an iPad was, itself,
developed from an iPad.

## Try it

Install from the [README](../../README.md#install), connect a node to a hub, and the connector
appears in your Claude app on its own. Then start with three examples: the
[connector walkthrough](../../examples/mcp-connector-install/), the
[mission autopilot](../../examples/mission-autopilot/), and — once you want a tool that does not
exist yet — [build your own MCP plugin](../../examples/build-your-own-mcp-plugin/) without a
terminal.
