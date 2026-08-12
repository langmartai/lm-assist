# ui-apps — lm-assist's own pluggable UIs

Scoped UIs (AUIS / agentic-ui-spec) that lm-assist ships for itself — the framework
managing itself through its own grant model. Deploy an app by copying it into the
node's apps root (default `~/.lmui/apps/<uiId>/`) and registering it (`ui_register`
over MCP, or `lmui register`); the node's lmui host process serves every sibling under
the apps root on the host UI port.

## assist-manage

The UI Pages manager as a scoped UI: owner-bound, scope `lm-assist`, one declared
grant — `node:/ui-pages [GET,POST,DELETE]`. Its data-plane calls relay through the hub
to THIS node's /ui-pages routes, which act on the platform gateway with the node's own
API key (the same trust path as the ui_* MCP tools). The page can list every UI on the
node, enable/disable registrations, start/stop local servers, toggle autostart, read
grants, and unregister — and can do nothing else: the view token's grant is its hard
ceiling (verified: /health outside the prefix → 403).

First member of the assist family (see backlog: port of assist-web to scoped UIs).
