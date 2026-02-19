---
allowed-tools: Bash
description: Search the lm-assist knowledge base
---

# /assist-search — Search Knowledge Base

Search across knowledge entries, milestones, and architecture using the lm-assist API.

## Steps

1. Check if the API is healthy:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

If the API is not running, tell the user to start services with `./core.sh start` or run `/assist-setup`.

2. The user's search query comes from `$ARGUMENTS`. If no arguments are provided, ask the user what they want to search for.

3. Search the knowledge base:
```bash
curl -s "http://localhost:3100/knowledge/search?q=${QUERY}&limit=${LIMIT}"
```

## Arguments

Parse `$ARGUMENTS` for:
- `--limit N` or `-n N`: Max results to return (default: 10)
- Everything else: The search query

Examples:
- `/assist-search authentication flow` — Search for "authentication flow"
- `/assist-search --limit 5 database schema` — Search with max 5 results
- `/assist-search refactoring` — Search for "refactoring"

## Output Format

For each result, display:
- Knowledge ID (e.g., K001)
- Title or subject
- Relevance score
- A brief excerpt of the content

Summarize the total number of results found and suggest using `/assist-search` with different terms if results are insufficient.
