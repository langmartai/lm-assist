# TikTok Promotion Content & Architecture

## TikTok 1: Mobile Terminal Control
**Visual:** Screenshot of the Claude Code terminal running on a mobile phone.
**On-Screen Text / Caption:**
> "Control your desktop Claude Code terminal directly from your phone! 📱💻 No extra setup needed—just connect and code on the go. #ClaudeCode #CodingOnMobile #DeveloperTools"

## TikTok 2: Session Knowledge Retrieval
**Visual:** Two screenshots (1 showing the knowledge list, 1 showing the knowledge detail view).
**On-Screen Text / Caption:**
> "Stop losing your AI chats! 🛑 Turn your Claude Code sessions into a searchable knowledge base. 🧠✨ Here’s how to retrieve past insights instantly. #AI #Productivity #Claude"

## TikTok 3: MCP/Hook for Any IDE
**Visual:** Screenshot showing the MCP integration settings or context injection in an IDE.
**On-Screen Text / Caption:**
> "Bring your Claude knowledge to ANY IDE! 🚀 Use MCP hooks to sync your sessions with VS Code, Cursor, Codex, and more. Code smarter, not harder. 🛠️🔥 #IDE #Cursor #VSCode #10xDeveloper"

---

## Architecture Diagrams

Here is the architecture split into two distinct diagrams, strictly following the Mermaid rules.

### 1. MCP & IDE Integration Architecture
```mermaid
graph LR
    subgraph "IDE Clients"
        Claude["Claude Code"]
        VSCode["VS Code"]
        Cursor["Cursor"]
        Other["Codex / Gemini / Antigravity"]
    end

    subgraph "lm-assist Core"
        MCP["MCP Server"]
        Hook["Context Hook"]
        VectorDB["Vector Store"]
    end

    Claude -->|"Uses"| MCP
    VSCode -->|"Uses"| MCP
    Cursor -->|"Uses"| MCP
    Other -->|"Uses"| MCP

    MCP -->|"Queries"| VectorDB
    Hook -->|"Injects Context"| Claude
```

### 2. Web UI & Local Services Architecture
```mermaid
graph TD
    subgraph "User Devices"
        Desktop["Desktop Browser"]
        Mobile["Mobile and Tablet"]
    end

    subgraph "Local Services"
        WebUI["Web UI - Port 3848"]
        CoreAPI["Core API - Port 3100"]
        Sessions["Session Data"]
    end

    Desktop -->|"Accesses"| WebUI
    Mobile -->|"Accesses"| WebUI
    
    WebUI -->|"REST API"| CoreAPI
    CoreAPI -->|"Reads and Writes"| Sessions
```
