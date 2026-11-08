# Firm agent definitions

These Markdown files define the career firm's agents. They are loaded at runtime by
`src/agents/definitions.ts`; editing one changes the next agent run without a rebuild
or restart.

## Format

```md
---
id: headhunter
name: Headhunter
role: headhunter
description: Decodes a posting, maps evidence, and scores the match.
schema: job_analysis
workflow: tailoring
temperature: 0.1
max_tokens: null
---

# System Prompt

You are ...

# Task

Analyse the job below and return the JobAnalysis JSON.

### JOB DESCRIPTION

{{job_description}}
```

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `id` | no | Unique agent id; defaults to the filename. |
| `name` | no | Human-readable name; defaults to `id`. |
| `role` | no | Audit role written to `agent_runs`; defaults to `id`. |
| `description` | no | One-line summary shown by `career-firm agents`. |
| `schema` | no | `parsed_cv`, `job_analysis`, `tailored_cv`, or `none` (default). |
| `workflow` | no | Workflow label written to `agent_runs`; defaults to `id`. |
| `temperature` | no | Sampling temperature; defaults to `0.2`. |
| `max_tokens` | no | Per-call token cap; `null` uses the global setting. |

## Sections

- `# System Prompt` — the role prompt. Required.
- `# Task` — the user task template. `{{name}}` placeholders are replaced with the
  values supplied by the calling agent; objects are pretty-printed as JSON. Keep
  subsection headings at `###` or deeper so they do not split the sections.

## Overrides

The loader searches the bundled `agents/` directory first, then `<home>/agents`
(default `data/agents`). A file in a later directory with the same `id` replaces the
bundled definition. `CAREER_FIRM_AGENTS_DIR` changes the override directory.
