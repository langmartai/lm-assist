# WhatsApp connector

Goal: send and read WhatsApp messages from any Claude session. What ships on `main` today is the
**Meta WhatsApp Cloud API** connector: the node holds your business number's credentials, sends
through the Graph API, and builds its message store from the events Meta pushes to the node's
webhook — the Cloud API has no "fetch history" call, so history accumulates from inbound
messages and delivery receipts. The tools ride the same hub relay as everything else.

> A second provider — driving a **personal** WhatsApp Web session in the node's own browser
> (CDP) — exists as the open "unify Meta + CDP connectors" pull request and is what the
> screenshot below shows; until it merges, the exchanges here describe the Cloud API path.

## One-time setup

Create a Meta app with the WhatsApp product, note the phone-number id, generate an access token,
copy the app secret, choose a webhook verify token, then hand them to the node (they're stored
node-locally, mode 0600) and point Meta's webhook at the node over public HTTPS. Full steps:
[`docs/whatsapp-connector.md`](../../docs/whatsapp-connector.md).

> **You:** is WhatsApp configured on this node?
>
> **Claude:** *(lm-assist → whatsapp_status)* Configured — phone number, token, and app secret
> are all set (secrets never leave the node; I only see booleans). The webhook has ingested 340
> messages across 12 chats so far, 3 unread.

Tools involved: whatsapp_status

## Everyday use

> **You:** did anyone say the meeting moved?
>
> **Claude:** *(lm-assist → whatsapp_search)* Two hits in the ingested store: "Ops group" on
> Aug 29 ("meeting moved to 3pm, same room") and "A. Vendor" on Aug 30 ("let me know if the
> meeting moved again"). Want the full Ops group thread?

Sends go out from your business number, so Claude confirms first — and the Cloud API's rules
apply: free-form text only delivers within 24 hours of the recipient's last inbound message;
starting a conversation needs a pre-approved template.

> **You:** yes — and tell the vendor we'll be there at 3
>
> **Claude:** *(lm-assist → whatsapp_read_messages)* A. Vendor last wrote 2 hours ago, so a
> free-form reply is inside the 24-hour window. Ready to send "We'll be there at 3" from your
> business number — send?
>
> **You:** send it
>
> **Claude:** *(lm-assist → whatsapp_send)* Sent — message id returned, delivery receipt will
> land in the store when Meta reports it.

Received attachments carry a media id, so they can be pulled onto the node:

> **You:** the vendor sent a voice note earlier — what does it say?
>
> **Claude:** *(lm-assist → whatsapp_get_media)* Fetched the voice note to the node. Short
> version: they confirm Thursday's delivery slot and ask you to reply with the gate code.

Tools involved: whatsapp_list_chats, whatsapp_read_messages, whatsapp_search, whatsapp_send, whatsapp_get_media

The personal WhatsApp Web provider from the open pull request, driving the operator's own tab
(content blurred):

![WhatsApp Web through the CDP provider (open PR), content masked](./whatsapp-masked.png)

Notes:
- Reads are served from what the node has **ingested** — a message sent before the webhook was
  pointed at the node is simply not there.
- The webhook is exempt from the lm-assist API token (Meta can't carry it); it authenticates
  with the verify-token handshake and an HMAC-SHA256 body signature, so set the app secret
  before exposing the endpoint.
- Sends act as your real business number — same care as any outward write.
