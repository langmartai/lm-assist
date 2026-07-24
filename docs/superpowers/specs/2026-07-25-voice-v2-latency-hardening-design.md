# voice-v2 latency + hardening — design

Post-ship enhancement of the bidirectional claude.ai voice on lm-assist
(`docs/superpowers/specs/2026-07-24-bidirectional-voice-v2-design.md` shipped it; `0f33806`
fixed the two prod breakages). Voice now works — it is just slow to open, and the regression
test that would have caught the breakage does not exist.

## 1. The problem, in prod evidence

`~/.cache/lm-assist/core-prod.log` on 117:

```
[claude-voice 8e197cf3] user closed: up=0 ctrl=0 downBin=0 downMsg=0 3198ms
[claude-voice 8e197cf3] user left during setup — closing the freshly-opened voice channel
[claude-voice ce8bc269] user closed: up=0 ctrl=0 downBin=0 downMsg=0 14980ms
[claude-voice ce8bc269] user left during setup — closing the freshly-opened voice channel
[claude-voice 92c7f7fe] user closed: up=11458 ctrl=0 downBin=4137 downMsg=294 261520ms
```

Voice is fully functional (the 261 s session moved 11 458 uplink and 4 137 downlink frames).
Users abandon it before it opens. Two independent costs stack:

**Server.** `core/src/voice/claude-chrome.ts` pays two hardcoded 10 s sleeps per session
(`DEFAULT_SETTLE_MS = 10_000`): `ensureLoaded` navigates a throwaway page, sleeps 10 s, then
**closes** it (`:180-186`); `openVoicePage` navigates again and sleeps 10 s again (`:221-226`).
~20 s before the mic can open, plus Chrome cold launch — and every session repeats it, because
nothing is retained between sessions.

**Client.** `web/src/hooks/useClaudeVoice.ts` only calls `bootEngine()` on the server's
`{ready}` frame (`:194`) — i.e. after the entire Chrome chain. The mic permission prompt and
capture start ~20 s after the click. This is also the root of the autoplay defect: `start()`
runs far outside the click's user-activation window, which is exactly why the engine's
`ac.resume()` had to become a best-effort `.catch()` in `0f33806`.

**Latent, found while designing.** `teardownIfIdle()` is implemented but **called from
nowhere** — the headless Chrome lives until Core restarts. Wiring it is now required (this
design retains a page *and* a timer), and wiring it naively would close the browser
mid-session, since `lastOpenAt` goes stale during a long call.

## 2. Server: condition-based readiness (removes the dead time)

Replace both fixed sleeps with a poll on the real signal. `VOICE_CHROME_SETTLE_MS` stops being
a floor and becomes the **cap**.

```
waitForClaudeReady(page, capMs):
  every VOICE_CHROME_READY_POLL_MS (250) until capMs:
      status = page.evaluate(fetch('/api/account', {credentials:'include'}).status)
      names  = (page.cookies('https://claude.ai')).map(c => c.name)
      if status === 200 && names.includes('cf_clearance')  -> ready
  cap hit, status === 200 -> proceed (log: cap reached, no cf_clearance)
  cap hit, status !== 200 -> proceed (log: warn)  — the asset's retry-once still covers it
  returns { ready, ms, status, cfClearance, cookieNames }
```

The poll's `GET /api/account` **is** `refreshCfCookies` — the same same-origin GET the CF fix
requires, now run repeatedly instead of once after a blind sleep. This is why the change
cannot regress `0f33806`: the real Chrome UA launch arg is untouched, and the `__cf_bm`
refresh happens strictly more often, immediately before the WS upgrade as before. A blind 10 s
sleep never confirmed either signal; this waits for both.

Cookie **names** only are read and logged. Values are never read, logged, or compared.

## 3. Server: persistent primed page + CF keepalive (removes the repeat)

Condition-based waiting removes the dead time; it does not stop the *next* session paying
navigation + challenge again. Keep **one** long-lived, already-navigated claude.ai page in the
Chrome manager.

The primed page is **not** the voice page. Cookies are browser-context-scoped, so the primed
page's job is only to hold a warm, continuously-refreshed `cf_clearance` + `__cf_bm` in the
shared jar. `openVoicePage` still opens its own page (it needs the `__lmToCore` binding, the
`__VOICE_URL__` global, and its own navigation for a same-origin WS), but that navigation now
lands on a warm origin and `waitForClaudeReady` returns on its first poll. Concurrent voice
sessions keep working.

```
ensureLoaded(cookie):
  b = getBrowser()                         // cold launch only
  if primedPage && cookie unchanged && age < MAX_AGE:
      if quickHealthCheck(primedPage)  -> return        (~50-150 ms)
  reprime(cookie)                          // single-flight

quickHealthCheck(page): !page.isClosed() && waitForClaudeReady(page, oneShot).ready
reprime(cookie):        close old + stop keepalive -> newPage -> setCookie -> goto
                        -> waitForClaudeReady(cap) -> start keepalive
```

Cheap validation before reuse, full re-prime on any failure, and periodic recycle
(`VOICE_PRIMED_MAX_AGE_MS`, default 30 min) to bound page-level leaks. Re-priming is
single-flight so two sessions starting together cannot prime twice. The cookie header is
fingerprinted only to detect rotation; the fingerprint is never logged.

**Keepalive must be a real request.** A no-op `setInterval` JS ping does not refresh cookies —
only a same-origin `GET /api/account` makes Cloudflare re-issue `Set-Cookie`. The keepalive
reuses `refreshCfCookies(primedPage)` on `VOICE_CF_KEEPALIVE_MS` (default 8 min, below
`__cf_bm`'s ~10 min working lifetime), `unref()`'d so it never holds the process open.

**Footprint is bounded.** An internal sweeper (`VOICE_CHROME_IDLE_SWEEP_MS`, 60 s, `unref()`'d)
finally makes `teardownIfIdle` real: after `VOICE_CHROME_IDLE_MS` (unchanged 5 min default)
with **zero live channels**, the primed page, the keepalive timer and the browser all go away.
The live-channel count is new and load-bearing — without it the sweeper would close Chrome
during a long call. `VOICE_PRIMED_PAGE=0` disables the persistent page entirely, reverting to
throwaway priming (still without the blind sleep).

## 4. Client: open the mic at click (removes the perceived latency)

`start()` opens the WS **and** boots the engine immediately, inside the user-activation window.

```
start()  ->  new WebSocket(...)          (async, as today)
         ->  void bootEngine()           (NEW: mic prompt + capture begin now)

onFrame(opus):  ready ? ws.send(opus)
                      : ring.push(opus), drop oldest past 250 frames
{ready}      :  flush ring -> ws.send each -> ready = true -> live passthrough
```

The ring is bounded at **250 frames ≈ 5 s** (20 ms Opus @ ~50 fps, ~60 B/frame ≈ 15 KB): the
user's opening words survive a short wait, and a long or failed wait can never inject a large
stale burst into claude.ai's server-side VAD.

This fixes autoplay at the root. `ac.resume()` now runs inside the activation window, so it
actually lands and playback works from the first downlink frame. The engine's non-blocking
resume from `0f33806` **stays** — it is the correct defensive shape, and re-introducing
`await ac.resume()` would restore the original hang. `playPcm`'s re-attempt also stays.

The state machine is unchanged: `connecting` until `{ready}`, then `listening`. The mic being
live before the transport is up is not a reason to claim `listening` — the overlay's pulsing
"Connecting…" is accurate, and the win (permission prompt + capture + resume at click) is real
without touching the UI contract.

`bootEngine` loses its `ws` argument and reads `wsRef.current`, so a socket replaced by a
stop/start cycle can never receive frames from an abandoned engine. Failure paths are
unchanged: `fail()` already tears down engine and socket unconditionally, which now correctly
covers "engine started before the socket ever opened".

## 5. The missing regression test

The merged Plan A e2e asserted only that `{ready}` arrives — which is precisely how a fully
broken audio path shipped. `{ready}` proves the transport; it proves nothing about audio.

`core/src/__tests__/voice-audio-flow.e2e.test.ts` asserts **audio flows**:

```
[headless Chrome, --use-fake-device-for-media-stream + --use-fake-ui-for-media-stream]
    web/public/voice/claude-voice-engine.js   (the real asset, not a stub)
        engine.start({ onFrame })  --ws.send(opus)-->
            real ws server -> bridgeClaudeVoice(userWs, { makeChromeMgr: stub, loadCookie })
                stub channel counts binary frames
                    ASSERT upBin > 0
```

Real Chrome, real engine, real relay; claude.ai stubbed at the documented `makeChromeMgr`
seam. It reaches through the `ws.send` guard and the relay pipe that engine-only coverage
would miss, and it needs no cookies or network. It **self-skips** when `resolveChromePath()`
returns null, so Chrome-less environments still pass `npm test`.

Deliberately absent: `--autoplay-policy=no-user-gesture-required`. The test must run under the
real autoplay condition, or it stops covering the bug it exists for.

## 6. Measurement

Phase timings are added to both logs (`ensureLoaded` / `openVoicePage` / readiness poll ms and
outcome; `first user audio frame relayed to channel (+Nms)` in the relay). Time-to-first-audio-frame
is then reported from prod 117 (`:3849` `/cowork`) for three cases:

| case | state |
|---|---|
| cold start | no browser — Chrome launch + prime + voice page |
| warm-browser start | browser alive, no primed page |
| primed-page start | browser alive, primed page healthy |

Verification is `page_status up_open -> ready` **plus `up>0`** in `core-prod.log` — never
`ready` alone.

## 7. Configuration

| env | default | meaning |
|---|---|---|
| `VOICE_CHROME_SETTLE_MS` | `10000` | now the **cap** on the readiness poll, not a fixed sleep |
| `VOICE_CHROME_READY_POLL_MS` | `250` | readiness poll interval |
| `VOICE_PRIMED_PAGE` | `1` | `0` disables the persistent primed page |
| `VOICE_PRIMED_MAX_AGE_MS` | `1800000` | recycle the primed page (30 min) |
| `VOICE_CF_KEEPALIVE_MS` | `480000` | CF keepalive interval (8 min); `0` = off |
| `VOICE_CHROME_IDLE_MS` | `300000` | unchanged — now actually enforced |
| `VOICE_CHROME_IDLE_SWEEP_MS` | `60000` | idle sweeper tick |

## 8. Invariants

1. The real Chrome UA launch arg and the `__cf_bm` refresh via same-origin `GET /api/account`
   are preserved exactly (`0f33806`, lm-mobile §4). The GET becomes more frequent, never less.
2. Cookie **names** only in logs. No cookie value is read, logged, or persisted.
3. The engine's non-blocking `ac.resume()` stays non-blocking.
4. The Chrome footprint is bounded and disable-able; the idle sweeper never fires while a
   channel is live.
