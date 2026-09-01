# WhatsApp connector

Goal: read and send WhatsApp messages from any Claude session. WhatsApp has no personal API — the
connector drives a real **WhatsApp Web** tab in the node's own browser (CDP, debug port **9222**)
and mirrors messages into a local store, because WhatsApp Web cannot backfill history the way
Gmail can.

## One-time setup

Link the node's browser to your phone once (QR scan in the connector's browser window). The
session persists in the dedicated profile.

## Everyday use

```
whatsapp_status                  → provider, linked state, ingest counters
whatsapp_list_chats              → chats seen so far (list accumulates across reads)
whatsapp_read_messages(chat)     → mirrored messages for one chat
whatsapp_search("delivery")      → search the mirrored store
whatsapp_send(chat, text)        → send as the linked account
whatsapp_get_media(id)           → fetch a received attachment
```

Illustrative session:

```
> whatsapp_status
  Provider: cdp · linked: yes · ingested: 340 messages across 12 chats
> whatsapp_search("meeting moved")
  2 hits — chat "Ops group" (2026-08-29), chat "A. Vendor" (2026-08-30)
```

The connector's actual tab (content blurred):

![WhatsApp Web through the connector, content masked](./whatsapp-masked.png)

Notes:
- WhatsApp Web allows **one active tab** — the connector owns it. Don't open web.whatsapp.com
  yourself on that profile, and treat the tab as having a single writer: a background mirror job
  plus interactive driving on the same tab means the wrong page for one of them.
- Because lists are mirrored as they are seen, the store grows with use; there is no "fetch all
  history" call.
- Sends act as the operator's real account — same care as any outward write.
