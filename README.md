# mcp-rap-migrator

**AI Agent that migrates SAP Module Pool programs → RAP applications, interactively.**

Built on MCP (Model Context Protocol) + Anthropic Claude + SAP ADT REST APIs.

---

## Architecture

```
Human Developer
    ↕ approves every step
Orchestrator Agent (Claude claude-sonnet-4-6)
    ↕ system prompt = MIGRATION_GUIDE.md (loaded once, token-efficient)
mcp-rap-migrator (THIS server) — write/transform tools
    ↕ delegates read-only calls to
mcp-abap-adt (mario-andreschak) — GetProgram, GetInclude, SearchObject
    ↕ both call
SAP ADT REST API  /sap/bc/adt/
    ↕
SAP ABAP System (S/4HANA or BTP ABAP)
```

## Why TWO MCP servers?

| Server | Responsibility | Reason |
|--------|---------------|--------|
| `mcp-abap-adt` | Read: GetProgram, GetClass, SearchObject | Already built, battle-tested, reuse it |
| `mcp-rap-migrator` (this) | Write + Transform: analyze, generate, write, activate | New — wraps ADT write APIs + AI code generation |

## Tools (this server)

| Tool | Purpose | Step |
|------|---------|------|
| `analyze_module_pool` | Read + parse Module Pool → structured JSON | 1 |
| `generate_rap_skeleton` | JSON analysis → CDS/BDef/Impl ABAP code strings | 2 |
| `human_checkpoint` | **MANDATORY gate** — shows human: what got, analysis, next action | Every step |
| `create_transport` | Create Workbench Transport Request in SAP | 3 |
| `write_abap_object` | PUT one ABAP object source via ADT REST | 4 |
| `validate_and_activate` | Activate objects, return syntax errors | 5 |

## Token Efficiency Design

- **`MIGRATION_GUIDE.md`** loaded once as system prompt — not re-sent every call
- `analyze_module_pool` returns **compact JSON** (not raw ABAP source)
- `human_checkpoint` shows only **first 30 lines** of code previews
- Errors: only the error message, not the full XML response body
- CSRF token **reused** across calls — not re-fetched every request

## Prerequisites

1. SAP system with `/sap/bc/adt` active in SICF
2. Also install: `mcp-abap-adt` — `npx -y @smithery/cli install @mario-andreschak/mcp-abap-adt --client cline`
3. Node.js 20+ and npm

## Setup

```bash
git clone <this-repo>
cd mcp-rap-migrator
npm install
npm run build
cp .env.example .env
# Edit .env with your SAP credentials
```

## Configure in Cline / Claude Desktop

```json
{
  "mcpServers": {
    "mcp-abap-adt": {
      "command": "node",
      "args": ["C:/PATH/mcp-abap-adt/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap.com:8000",
        "SAP_USERNAME": "user",
        "SAP_PASSWORD": "pass",
        "SAP_CLIENT": "100"
      }
    },
    "mcp-rap-migrator": {
      "command": "node",
      "args": ["C:/PATH/mcp-rap-migrator/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap.com:8000",
        "SAP_USERNAME": "user",
        "SAP_PASSWORD": "pass",
        "SAP_CLIENT": "100"
      }
    }
  }
}
```

## Usage

In Cline or Claude Code, with `MIGRATION_GUIDE.md` loaded as system prompt:

```
Migrate the module pool program SAPMZ_DEMO to RAP. 
Use package ZMIGRATED and prefix ZR_.
```

The agent will:
1. Analyze the program → show you what it found → ask permission
2. Generate all RAP objects → show code preview → ask permission  
3. Create a transport → write each object one-by-one → checkpoint each
4. Activate all → show results → checkpoint

**You control every step.**

## Extending

Add new tools in `src/tools/` and register them in `src/index.ts`.

Ideas:
- `generate_odata_service` — expose the RAP BO as an OData V4 service
- `run_atc_check` — run ABAP Test Cockpit on generated objects
- `compare_behavior` — run both old + new, compare DB results
