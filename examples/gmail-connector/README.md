# Gmail connector

Goal: read, search, and act on a real Gmail account from any Claude session — driving the
operator's **own logged-in browser** over the DevTools Protocol. No Google API project, no OAuth
app: the node owns a dedicated Chrome profile that stays signed in.

## One-time setup

> **You:** is Gmail connected on this node?
>
> **Claude:** *(lm-assist → gmail_status)* Not yet — the driver browser isn't signed in. Want me to open the login window?
>
> **You:** yes, go ahead
>
> **Claude:** *(lm-assist → gmail_login)* A Chrome window just opened at mail.google.com on this node. Sign in once (account + 2FA) and you're done — the session persists in the dedicated profile.

Tools involved: gmail_status, gmail_login

The profile lives in the node's own directory on debug port **9224** (WhatsApp uses 9222 and
LinkedIn 9223, so all three connectors run side by side). After the one-time headed login the
connector operates headless against the same profile — the session survives restarts.

## Everyday use

> **You:** any invoices in my mail this week?
>
> **Claude:** *(lm-assist → gmail_search)* Three threads match `subject:invoice newer_than:7d`: "Invoice #4021 — March" from A. Vendor (2 messages, unread), "Your invoice is ready" (1 message), and "Re: invoice adjustment" (5 messages). Want me to open the first one?
>
> **You:** open it
>
> **Claude:** *(lm-assist → gmail_read_thread)* Two messages, live from the mailbox. Tuesday: A. Vendor sent invoice #4021 for March services, net-30. Yesterday: a follow-up asking whether it reached the right inbox. Nobody has replied yet.

Searches take any Gmail query — search is a URL change, not UI typing — and results are keyed by
Gmail's REAL thread ids. Writes go out from the account's default send-as identity, and Claude
confirms before anything sends:

> **You:** reply that we received it and payment goes out Friday, then label the thread "Accounting"
>
> **Claude:** Draft reply: "Hi — confirming we received invoice #4021. Payment is scheduled to go out Friday." This sends immediately from the account's default send-as identity — go ahead?
>
> **You:** send it
>
> **Claude:** *(lm-assist → gmail_reply, gmail_apply_label)* Sent to the thread's participants, and the thread now carries the "Accounting" label.

Tools involved: gmail_list_threads, gmail_read_thread, gmail_search, gmail_labels, gmail_apply_label, gmail_send, gmail_reply, gmail_draft

Every read is **live** — Gmail owns read-state server-side and can backfill history, so there is
no local message store to drift. The DOM exposes real server ids (`data-legacy-thread-id`), so
threads are keyed properly rather than by display name.

The connector's actual browser (content blurred):

![Gmail inbox through the connector, content masked](./gmail-inbox-masked.png)

![An open thread, content masked](./gmail-thread-masked.png)

Notes:
- Tools are advertised fleet-wide but only a node with a signed-in profile can serve them — ask
  `gmail_status` per node. Restarting that node's Core kills the browser it launched; the next
  call relaunches it from the persisted profile.
- The account can carry multiple send-as identities; "who is this mail from" is read from the
  compose dialog, never inferred from the signed-in address.
