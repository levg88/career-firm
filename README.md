# Resume Firm

A small, local-first **agent-run career firm**. Import your CV versions and a context
file once. For every job description, a headhunter agent screens the role, maps your
evidence to its requirements, and a resume-writer agent produces a tailored,
ATS-safe **PDF + DOCX** — stored in a local SQLite database with a full audit trail.

It also ships the reusable agent infrastructure that built it:

- **Firm agents:** Office Manager, Headhunter, Resume Writer
- **Build agents:** Product Manager, Architect, Developer, QA
- **Runtime:** provider-agnostic LLM client, tool-calling loop, sandboxed workspace, SQLite audit log

> **LinkedIn:** v1 deliberately does **not** log in to LinkedIn. LinkedIn has no API that
> exposes your CV or full profile, and automated login/scraping violates its terms. The
> compliant workflow is to import your CV files and, if you want, a LinkedIn
> “Save to PDF” profile export. The Office Manager accepts DOCX, PDF, TXT, and Markdown.

---

## What it does

```text
                         CONFIG STAGE (once)
  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐
  │ Context file │   │ CV version: AI   │   │ CV version: Fintech │  … more verticals
  └──────┬───────┘   └────────┬─────────┘   └──────────┬──────────┘
         └────────────────────┴────────────────────────┘
                              │
                     ┌────────▼─────────┐
                     │  Office Manager  │  faithful structured record
                     │     agent        │  (no invented facts)
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
   Job description ──►│   Headhunter     │  must-haves, ATS keywords,
   (paste or file)    │     agent        │  evidence map, match score, gaps,
                     └────────┬─────────┘  best CV vertical
                              │
                     ┌────────▼─────────┐
                     │  Resume Writer   │  selects / reorders / rephrases
                     │     agent        │  only supported content
                     └────────┬─────────┘
                              │
                  ┌───────────┴───────────┐
                  │  Grounding validator  │  flags new employers, years,
                  │  (deterministic)      │  metrics, contact details
                  └───────────┬───────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
            ┌────▼────┐              ┌─────▼─────┐
            │   PDF   │              │   DOCX    │
            └────┬────┘              └─────┬─────┘
                 └───────────┬─────────────┘
                             │
                    ┌────────▼─────────┐
                    │ SQLite + files   │  jobs, analyses, generated CVs,
                    │ local storage    │  agent runs, artifacts
                    └──────────────────┘
```

### The firm agents

| Agent | Responsibility | Guardrail |
|---|---|---|
| **Office Manager** | Reads the context file and CV versions; extracts a structured, fact-preserving record. | Never infers employers, titles, dates, degrees, or metrics. |
| **Headhunter** | Decodes the posting; separates must-haves from nice-to-haves; maps each requirement to quoted evidence; scores the match; recommends the best CV vertical; lists gaps and a tailoring plan. | Gaps are gaps. Adjacent experience is not counted as direct evidence. |
| **Resume Writer** | Selects and rewrites the strongest existing content for the role; mirrors ATS language; keeps every employer, title, and date; renders PDF + DOCX. | Only facts in the source CV/context. No invented metrics or scope. |

A deterministic **grounding validator** runs after generation and flags any employer,
year, number, email, or phone that is not present in the source material. Warnings are
shown in the UI and stored with each generated CV. It is a safety net, not a truth
oracle — always review before sending.

### The general build agents

The same runtime powers a reusable software team:

| Agent | Output |
|---|---|
| **Product Manager** | Product spec, user stories, acceptance criteria, non-goals, risks |
| **Architect** | Stack, file plan, data model, interfaces, test plan |
| **Developer** | Real files written into a sandboxed workspace, tests run |
| **QA** | Acceptance-criteria review, test run, pass/fail report |

Use it from the UI (`Build lab`) or the CLI (`resume-firm build "..."`). Each run gets
its own workspace under `data/runs/build_<id>/workspace/`, and every artifact is stored
in SQLite.

---

## Quickstart

Requirements: **Python 3.11+** (tested on 3.14), no Node, no LibreOffice, no Pandoc.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

resume-firm serve
```

Open <http://127.0.0.1:8765>. On first run the local **setup wizard** asks for your
provider, model, API key, and lets you paste or upload your context and CV. There is no
config file to edit — everything is stored inside `data/firm.db` on your machine.

If you choose **Offline mode** (or skip a key), the app runs using deterministic
heuristics. It still parses CVs, scores jobs, generates PDF/DOCX, and stores everything;
the language is less nuanced than a real model. The UI shows a banner when this is the
case.

### First-run setup

The wizard is served by the app itself:

1. Run `resume-firm serve` and open the printed URL.
2. Choose a provider: **OpenAI / OpenAI-compatible**, **Anthropic**, **Ollama**, or
   **Offline mode**.
3. Paste an API key when the provider needs one. For OpenRouter, vLLM, a proxy, or a
   self-hosted Ollama, set the base URL too.
4. Optionally paste or upload your context brief and one CV version right away. You can
   add more CV versions later.
5. Save. The firm opens on the dashboard.

Afterwards, use **Settings** in the navigation to change the provider, key, defaults, or
imports at any time. Keys are masked in the UI after saving.

### Configure your profile

In the web UI:

1. **Profile → Context file** — paste or upload a stable brief about you (target roles,
   differentiators, industries, constraints, compensation direction).
2. **Profile → Add a CV version** — upload each CV with a vertical label such as
   `AI Platforms`, `Fintech`, or `Engineering Leadership`.

Or from the CLI:

```bash
resume-firm profile set-context ./examples/context.example.md
resume-firm profile add-cv ./examples/cv.example.md --vertical "AI Platforms"
resume-firm profile show
```

### Tailor a CV

Web: **Tailor CV** → paste/upload the job description → wait for the run.

CLI:

```bash
resume-firm job add --file ./jd.txt --title "VP Engineering" --company "Nimbus AI"
resume-firm job list
resume-firm job show 1
```

Outputs are saved under:

```text
data/
  firm.db
  storage/
    context/
    cvs/profile_1/
    jobs/profile_1/
    generated/job_1/
      Jane-Doe_Nimbus-AI_VP-Engineering_20261105-164240.pdf
      Jane-Doe_Nimbus-AI_VP-Engineering_20261105-164240.docx
  runs/
    tailor_1/
    build_1/workspace/
```

---

## CLI reference

```text
resume-firm init                         Initialise DB and data directories
resume-firm config                       Print effective config (no secrets)
resume-firm doctor                       Check provider, deps, fonts, DB stats
resume-firm profile show                 Profile + CV inventory
resume-firm profile set-context FILE     Import the context file
resume-firm profile add-cv FILE --vertical NAME
resume-firm profile list-cvs
resume-firm job add --file JD [--title T] [--company C] [--language en] [--no-run]
resume-firm job run ID                   Re-run tailoring
resume-firm job list
resume-firm job show ID [--json]
resume-firm build "BRIEF" [--title T]    Run PM → architect → developer → QA
resume-firm serve [--host H] [--port P]
resume-firm agents [--prompt ROLE]       List roles / print a role prompt
```

`--home DIR` overrides the data directory for any command.

---

## Configuration

Runtime configuration lives in the local SQLite database (`app_settings` table) and is
managed from the web UI:

- **First run:** the app redirects to `/setup`.
- **Later changes:** open **Settings** in the navigation bar.

API keys are stored only in `data/firm.db`. The database is created with file mode
`0600`, and keys are sent only to the provider you select. Nothing is written to a
`.env` file.

### Environment overrides (optional)

Environment variables are still supported for headless use, CI, and tests. Once you
finish the wizard, the stored configuration takes precedence.

| Variable | Default | Purpose |
|---|---|---|
| `RESUME_FIRM_PROVIDER` | auto | `openai`, `anthropic`, `ollama`, or `mock` |
| `RESUME_FIRM_MODEL` | provider-specific | Model ID |
| `RESUME_FIRM_SETUP_COMPLETE` | auto | Set `false` to force the wizard on next start |
| `OPENAI_API_KEY` | — | OpenAI or compatible provider |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | Native Anthropic adapter |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | Anthropic-compatible endpoint |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama’s OpenAI-compatible endpoint |
| `RESUME_FIRM_TEMPERATURE` | `0.2` | Generation temperature |
| `RESUME_FIRM_MAX_TOKENS` | `8192` | Per-call limit |
| `RESUME_FIRM_MAX_STEPS` | `12` | Tool-calling loop cap |
| `RESUME_FIRM_TIMEOUT` | `180` | Provider request timeout (seconds) |
| `RESUME_FIRM_HEURISTIC_FALLBACK` | `true` | Fall back to deterministic agents if a model call fails |
| `RESUME_FIRM_HOME` | `./data` | Database, uploads, generated files, run workspaces |
| `RESUME_FIRM_MAX_UPLOAD_MB` | `15` | Upload limit |
| `RESUME_FIRM_HOST` | `127.0.0.1` | Bind address |
| `RESUME_FIRM_PORT` | `8765` | Bind port |
| `RESUME_FIRM_LANGUAGE` | `en` | Default output language |
| `RESUME_FIRM_FONT_PATH` | auto | Optional TTF for PDF rendering |

Provider behaviour:

- **OpenAI-compatible** covers OpenAI, Ollama, OpenRouter, vLLM, and similar.
- **Anthropic** uses the native Messages API with tool use.
- **Ollama** uses its OpenAI-compatible endpoint; no API key is required.
- **Offline mode** is fully local and deterministic.
- If a provider is selected but its key is missing, the app degrades to offline mode with
  a visible banner instead of crashing.

---

## ATS and document rules

Generated files follow conservative, parser-friendly rules:

- Single column, no tables, columns, text boxes, images, icons, headers, or footers.
- Standard section headings: Professional Summary, Core Competencies, Professional
  Experience, Education, Certifications, Skills, Languages.
- Real selectable text (not an image), standard fonts, normal bullet characters.
- PDF auto-fits to **two pages** by shrinking font/spacing in small steps.
- DOCX uses Calibri; PDF uses Arial (macOS) / DejaVu (Linux) with an Arial Unicode
  fallback for non-Latin text.
- No hidden keyword blocks or white text.

The writer may mirror the posting’s terminology, but only where the source CV supports
it. Unsupported ATS keywords are automatically removed by the grounding layer.

---

## Truthfulness model

The system separates **facts** from **presentation**:

1. **Facts** — employers, titles, dates, degrees, certifications, locations, metrics,
   and scope — must come from the source CV or context.
2. **Presentation** — selection, ordering, compression, rephrasing, headline, summary,
   and keyword mirroring — can be tailored per job.

The writer prompt enforces this, and the deterministic validator checks it:

- Every generated employer must appear in the source/context.
- Every year in a generated date range must appear in the source/context.
- Every number in a bullet must appear in the source/context.
- Email and phone must appear in the source/context.
- Terms listed in `do_not_claim` must not appear in generated claims.
- Unsupported ATS keywords are removed.

Warnings do not block the download; they are shown prominently for review.

---

## Data model

SQLite (`data/firm.db`):

| Table | Contents |
|---|---|
| `profiles` | Context text and source filename |
| `cv_versions` | Vertical, file path, raw text, structured parse |
| `jobs` | Job description, title, company, language, status, error |
| `analyses` | Headhunter JSON, score, selected CV |
| `generated_cvs` | Tailored content JSON, PDF/DOCX paths, warnings |
| `workflow_runs` | Tailor/build runs, status, workspace, error |
| `agent_runs` | Role, provider, model, tokens, input/output audit |
| `artifacts` | Build-lab specs, architecture, reports and paths |
| `app_settings` | Provider, model, base URLs, keys, defaults saved by the setup wizard |

Files are stored under `data/` and never leave your machine unless your configured model
provider receives the prompt. SQLite uses WAL mode and a connection per operation.

---

## Extending

### Add a firm agent

Each agent lives in its own package under `src/resume_firm/agents/`:

```text
agents/
  office_manager/   agent.py
  headhunter/       agent.py
  resume_writer/    agent.py
  product_manager/  agent.py
  architect/        agent.py
  developer/        agent.py
  qa/               agent.py
  build_team.py     facade used by the build pipeline
  base.py           shared Agent / AgentSpec runtime
  runner.py         schema validation, retries, audit logging
  tools.py          sandboxed file and command tools
  prompts.py        system prompts for every role
```

To add an agent:

1. Add a prompt in `src/resume_firm/agents/prompts.py`.
2. Create `src/resume_firm/agents/<name>/agent.py` with a class that wraps
   `Agent` + `run_agent(...)`.
3. Export it from the package `__init__.py` and from `agents/__init__.py`.
4. Call `run_agent(...)` with a Pydantic schema so the output is validated and audited.
5. Wire it into `FirmService` or a new orchestrator.

### Add a future app

Use the build pipeline as a starting point:

```bash
resume-firm build "A local CLI that manages a reading list with tags and search" --title "Reading list"
```

The developer agent writes into `data/runs/build_<id>/workspace/`, and QA runs the test
suite there. The general runtime has no dependency on the CV firm, so it can be reused
for other products.

### Add a provider

Implement `LLMClient.complete(...)` in `src/resume_firm/llm/`, normalize tool calls to
`ToolCall`, and register it in `build_llm`.

---

## Security and privacy

- Local-only by default: binds to `127.0.0.1`.
- No telemetry, no analytics, no external asset CDNs.
- Provider keys live only in the local SQLite database (`data/firm.db`, mode `0600`) and
  are sent only to the provider you configure. The UI masks them after saving.
- Uploads are extension-checked and size-limited; filenames are sanitized.
- The build sandbox prevents path escapes and allows a small command allowlist. It is an
  isolation convenience, not a hardened security boundary — run only code you trust.
- Data at rest is otherwise unencrypted. Use full-disk encryption and back up `data/` if
  needed.
- Sending CV/context text to a cloud model provider is your choice; use Ollama for a
  fully local setup.

---

## Tests

```bash
pytest -q
```

Covered: heuristic parsing, job analysis, tailoring, grounding, DOCX/PDF extraction and
rendering, SQLite round-trips, the firm workflow, the build pipeline, the agent
tool-calling loop, JSON repair, sandbox guards, the startup setup wizard and config
persistence, and all web routes (including uploads, downloads, and background tasks).

---

## Limitations and roadmap

- **LinkedIn:** no automated login/scraping. Planned: compliant OAuth basics and a
  guided LinkedIn PDF-export importer.
- **Language:** output language follows the posting or `RESUME_FIRM_LANGUAGE`. DOCX
  handles Unicode; PDF uses system Unicode fonts. Complex RTL shaping may need
  `uharfbuzz` and a font with the right coverage.
- **Page fitting** is approximate: the PDF is measured and shrunk to two pages; the DOCX
  uses the same scale but Word’s layout can differ slightly.
- **Grounding** is conservative pattern matching, not semantic proof. Review warnings.
- **Single user:** no authentication or multi-tenant isolation. Do not expose the server
  to untrusted networks.
- **LinkedIn profile PDFs** extract less reliably than a proper DOCX CV; prefer DOCX for
  the structured import.

---

## License

MIT.
