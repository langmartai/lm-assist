# LinkedIn connector

Goal: read your LinkedIn feed, notifications and messages — and post, comment, connect, or
message — from any Claude session. There is **no personal LinkedIn API**, so every read and write
drives a real logged-in browser (CDP, debug port **9223**, its own persistent profile).

## One-time setup

```
linkedin_status        # signed in on this node?
linkedin_login         # if not: opens a headed browser at linkedin.com — log in with
                       # email / password / 2FA once; the profile keeps the session
```

Poll `linkedin_status` until `loggedIn: true`.

## Everyday use

```
linkedin_read_feed / linkedin_read_notifications
linkedin_list_conversations / linkedin_read_messages
linkedin_search("site reliability") / linkedin_search_people("platform engineer")
linkedin_post("…") / linkedin_comment / linkedin_publish_article
linkedin_connect / linkedin_follow / linkedin_send_message / linkedin_message_profile
```

Illustrative session:

```
> linkedin_read_notifications
  5 new — 2 reactions on your post, 1 comment, 2 invitations
> linkedin_post("We just shipped v0.2.0 — the control-plane release…")
  Posted as the signed-in account.
```

Notes:
- LinkedIn **virtualizes** its lists: a read captures only what is currently rendered, and results
  accumulate across calls — there is no "fetch history".
- Writes act on the operator's real account and profile; treat posts/messages like any outward
  publication.
- Tools are node-scoped: the node with the signed-in profile serves them (`linkedin_status` per
  node tells you which).
