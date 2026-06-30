# WhatsApp Connector (Cloud API)

lm-assist can send and read WhatsApp messages through the official **Meta
WhatsApp Cloud API**, exposed as MCP tools that ride the same hub relay as the
rest of the connector. Once configured, the `whatsapp_*` tools appear in any
Claude Code / claude.ai session connected to this node.

## How it fits the architecture

```
claude.ai / Claude Code
  └─ mcp__…_lm-assist_…_whatsapp_*           (MCP tools)
       └─ LangMart hub  ──api_relay──▶  Core  (/whatsapp/* on loopback)
                                          ├─ client.ts  ──▶ graph.facebook.com   (SEND)
                                          └─ store.ts   ◀── /whatsapp/webhook    (RECEIVE)
                                                              ▲
                                          Meta servers ───────┘  (POST inbound events)
```

- **Send** goes out to the Graph API (`POST /{phoneNumberId}/messages`).
- **Read** is served from messages this node has **ingested via webhook** — the
  Cloud API has no "fetch history" endpoint, so the store is built up over time
  from inbound events + delivery receipts.

Tools (scopes): `whatsapp_send` (write), `whatsapp_list_chats`,
`whatsapp_read_messages`, `whatsapp_search`, `whatsapp_status` (read).

REST routes (all under Core): `GET|POST /whatsapp/webhook`, `GET /whatsapp/status`,
`PUT /whatsapp/config`, `POST /whatsapp/send`, `GET /whatsapp/chats`,
`GET /whatsapp/messages`, `GET /whatsapp/search`.

## One-time Meta setup

1. Create a **Meta app** (https://developers.facebook.com) and add the
   **WhatsApp** product.
2. From **WhatsApp → API Setup**, note the **Phone number ID** and generate an
   **access token** (use a System User for a permanent token in production).
3. In **App settings → Basic**, copy the **App Secret**.
4. Pick any string as your **webhook verify token** (you choose it; Meta echoes
   it back during verification).

## Configure this node

Credentials are stored node-locally in `~/.lm-assist/whatsapp.json`
(`whatsapp-dev.json` when running from the repo), mode `0600`. Set them via the
route:

```bash
# dev :3200 (repo) / prod :3100 (npm). Use the matching API token.
curl -X PUT localhost:3200/whatsapp/config \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $LM_API_KEY" \
  -d '{
    "phoneNumberId": "1234567890",
    "accessToken": "EAAB...",
    "appSecret": "abc123...",
    "verifyToken": "my-verify-token",
    "businessAccountId": "9876543210",
    "displayPhoneNumber": "+1 555 010 1234"
  }'

curl localhost:3200/whatsapp/status -H "x-api-key: $LM_API_KEY"
```

`status` never returns secrets — only booleans for which fields are set, plus
ingested message/chat/unread counts.

## Point Meta's webhook at this node

Meta must reach `…/whatsapp/webhook` over public HTTPS. The webhook is
**exempt from the lm-assist API token** (Meta can't carry it); it authenticates
with the verify token (GET handshake) and an **HMAC-SHA256 body signature**
(`X-Hub-Signature-256`, keyed by the App Secret) on POST. **Set `appSecret`** —
without it, inbound POSTs are accepted unsigned (`status` flags this as
`appSecretSet:false`).

Expose the endpoint one of two ways:

- **Tunnel** to the node: `cloudflared tunnel --url http://localhost:3100` (or
  ngrok), then use the public URL.
- **Hub ingress**: `/whatsapp` is on the relay allow-list, so a public hub route
  to this worker's `/whatsapp/webhook` also works where the gateway exposes one.

In **WhatsApp → Configuration → Webhook**, set:

- **Callback URL**: `https://<public-host>/whatsapp/webhook`
- **Verify token**: the same string you saved as `verifyToken`
- **Subscribe** to the `messages` field.

Meta sends a `GET` with `hub.challenge`; the route echoes it back as plain text
when the verify token matches, completing registration.

## Usage

```bash
# Send free-form text (only delivers within 24h of the recipient's last message)
curl -X POST localhost:3200/whatsapp/send -H "x-api-key: $LM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"to":"+14155551234","text":"Build is green ✅"}'

# Start a conversation outside the 24h window with an approved template
curl -X POST localhost:3200/whatsapp/send -H "x-api-key: $LM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"to":"+14155551234","template":{"name":"hello_world","languageCode":"en_US"}}'

curl "localhost:3200/whatsapp/chats" -H "x-api-key: $LM_API_KEY"
curl "localhost:3200/whatsapp/messages?chat=14155551234&markRead=true" -H "x-api-key: $LM_API_KEY"
curl "localhost:3200/whatsapp/search?q=invoice" -H "x-api-key: $LM_API_KEY"
```

Or, from a connected Claude session: *"send a WhatsApp to +1 415 555 1234 saying
the deploy finished"*, *"read my WhatsApp thread with Alice"*, *"any unread
WhatsApp chats?"*.

## Notes & limits

- **24h window**: free-form `text` only delivers within 24h of the recipient's
  last inbound message. Outside it, use an approved `template`.
- **History**: reads reflect only what arrived after the webhook was connected —
  there's no backfill of older chats (Cloud API limitation).
- **Storage**: messages append to `~/.lm-assist/whatsapp/messages.jsonl`;
  per-chat read-state in `read-state.json` (same dir). Both are node-local.
