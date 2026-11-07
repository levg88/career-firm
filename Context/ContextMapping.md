# ContextMapping — Agent Knowledge Router

> Single entry point for domain knowledge in this repo. Read this FIRST, then read the `Memory.md` files for the topics your task touches.

## How to use

0. **Always first — project orientation**: read `Context/Overview/Memory.md` before anything else, regardless of topic match. It says what this project is and how it is organized. Skip only if it is already in your context this session.
1. **Before a task**: find your topic(s) in the table below (aliases count). Read those `Memory.md` files.
2. **During/after a task**: learned substantial new domain info? Write it to `Context/_inbox/` (format: `_inbox/README.md`). Do NOT edit `Memory.md` directly — the Librarian agent (`/curate-context`) owns those files.
3. **Explicit load**: `/context <topic>` loads a topic's Memory.md into the conversation.

## Topic table

| Topic | Aliases | Path |
|---|---|---|
| Overview | project overview, what this project is, orientation | `Context/Overview/Memory.md` |
| Firm Agents | agents, office manager, headhunter, resume writer | `Context/Agents/Firm-Agents/Memory.md` |
| LLM Providers | providers, ollama, openrouter, model routing, offline mode | `Context/Agents/LLM-Providers/Memory.md` |
| Job Analysis | job analysis, ats keywords, match score, must-haves | `Context/Domain/Job-Analysis/Memory.md` |
| CV Tailoring | cv tailoring, resume writer, grounding, truthfulness | `Context/Domain/CV-Tailoring/Memory.md` |
| Document Rendering | pdf, docx, page fitting, fonts, ats formatting | `Context/Domain/Document-Rendering/Memory.md` |
| CV Import | cv import, linkedin export, pdf extraction, docx parsing | `Context/Domain/CV-Import/Memory.md` |
| Data Storage | sqlite, database schema, data directory, workflow runs | `Context/Platform/Data-Storage/Memory.md` |
| Setup Settings | setup wizard, settings, api keys, provider config | `Context/Platform/Setup-Settings/Memory.md` |
| CLI Operations | cli, doctor, serve, home directory | `Context/Platform/CLI-Operations/Memory.md` |
| Testing CI | tests, vitest, github actions, typecheck | `Context/Platform/Testing-CI/Memory.md` |

## External sources (canonical home is NOT Context/)

| Topic | Canonical source |
|---|---|
| Config values | `data/firm.db` `app_settings` table (managed via Settings UI) — the single source of truth |
| Environment overrides | `README.md` Configuration section and `src/config.ts` — canonical list of variables and defaults |
| Code structure | `src/**` and the README "Extending" section — no generated code graph exists |
| API routes | `src/api/app.ts` |
| Database schema | `src/db.ts` `SCHEMA` constant |

## Write rules

1. Domain knowledge only — knowledge about the code's structure belongs in generated docs or a code graph, not here.
2. **NEVER secrets or credentials** (passwords, tokens, connection strings).
3. **Every fact tagged** `(provider / OS, YYYY-MM-DD)` or `(General)`.
4. Supersede, don't append duplicates — a newer dated fact replaces an older one.
5. All writes go through `_inbox/` → Librarian. New topics: the Librarian creates the folder and registers it here.
6. **Auth-gated external sources** (SSO wikis, SharePoint): a URL pointer alone is useless to a headless agent. Mirror the content as a dated snapshot file NEXT TO the topic's `Memory.md`, link it from that file's Pointers section, and note the refresh procedure. `Memory.md` keeps the stable facts; the mirror holds the volatile tables.
