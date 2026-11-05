from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import sys
import uuid
from pathlib import Path

from . import db
from .config import Settings
from .documents.extract import ExtractionError, extract_text
from .llm import build_llm
from .llm.mock import MockClient
from .orchestrator.firm import FirmService


def _safe_filename(name: str) -> str:
    name = Path(name).name
    cleaned = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in name).strip()
    return cleaned[:120] or "upload"


def _profile_id(settings: Settings) -> int:
    with db.session(settings.db_path) as conn:
        return int(db.get_or_create_profile(conn)["id"])


def _apply_stored_settings(settings: Settings) -> Settings:
    db.init_db(settings.db_path)
    with db.session(settings.db_path) as conn:
        stored = db.get_app_settings(conn)
    if stored:
        settings.apply_config(stored)
    try:
        os.chmod(settings.db_path, 0o600)
    except OSError:
        pass
    return settings


def _read_description(args) -> str:
    if getattr(args, "text", None):
        return args.text
    if getattr(args, "stdin", False):
        return sys.stdin.read()
    if getattr(args, "file", None):
        path = args.file
        if path == "-":
            return sys.stdin.read()
        return extract_text(path)
    raise SystemExit("Provide a job description with --text, --file, or --stdin.")


def cmd_init(settings: Settings, args) -> int:
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    profile_id = _profile_id(settings)
    print(f"Initialised Career Firm in {settings.data_dir}")
    print(f"  database: {settings.db_path}")
    print(f"  profile id: {profile_id}")
    print(f"  provider: {settings.provider} / {settings.model}")
    print("Next: career-firm profile set-context <file> and profile add-cv <file> --vertical <name>")
    return 0


def cmd_config(settings: Settings, args) -> int:
    print(json.dumps(settings.public_dict(), indent=2))
    return 0


def cmd_doctor(settings: Settings, args) -> int:
    db.init_db(settings.db_path)
    llm = build_llm(settings)
    print("Career Firm doctor")
    print(f"  python: {sys.version.split()[0]}")
    print(f"  data: {settings.data_dir}")
    print(f"  database: {settings.db_path}")
    print(f"  provider: {settings.provider}")
    print(f"  model: {settings.model}")
    if isinstance(llm, MockClient) and llm.reason:
        print(
            f"  WARNING: running offline ({llm.reason}). "
            "Open Settings in the web app to choose a provider."
        )
    else:
        print(f"  client: {type(llm).__name__}")
    for module in ("fastapi", "uvicorn", "jinja2", "docx", "pypdf", "fpdf", "httpx"):
        try:
            __import__(module)
            print(f"  dependency {module}: ok")
        except Exception as exc:
            print(f"  dependency {module}: MISSING ({exc})")
    font = settings.font_path or "/System/Library/Fonts/Supplemental/Arial.ttf"
    print(f"  pdf font: {font} ({'found' if Path(font).is_file() else 'not found'})")
    with db.session(settings.db_path) as conn:
        print("  stats: " + json.dumps(db.stats(conn)))
    return 0


def cmd_profile(settings: Settings, args) -> int:
    db.init_db(settings.db_path)
    profile_id = _profile_id(settings)
    if args.profile_command == "show":
        with db.session(settings.db_path) as conn:
            profile = db.get_profile(conn, profile_id)
            cvs = db.list_cvs(conn, profile_id, active_only=False)
        print(f"profile #{profile_id}")
        print(f"context: {len(profile['context_text'])} chars ({profile['context_filename'] or 'none'})")
        print(f"cvs: {len(cvs)}")
        for cv in cvs:
            state = "active" if cv["is_active"] else "inactive"
            print(f"  #{cv['id']} [{cv['vertical']}] {cv['filename']} ({state})")
        return 0

    if args.profile_command == "set-context":
        source = Path(args.file)
        if not source.is_file():
            raise SystemExit(f"File not found: {source}")
        raw = extract_text(source)
        dest_dir = settings.storage_dir / "context"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{uuid.uuid4().hex[:8]}_{_safe_filename(source.name)}"
        shutil.copy2(source, dest)
        FirmService(settings).set_context(profile_id=profile_id, text=raw, filename=source.name)
        print(f"Context saved ({len(raw)} chars) from {source.name}")
        return 0

    if args.profile_command == "add-cv":
        source = Path(args.file)
        if not source.is_file():
            raise SystemExit(f"File not found: {source}")
        raw = extract_text(source)
        dest_dir = settings.storage_dir / "cvs" / f"profile_{profile_id}"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{uuid.uuid4().hex[:8]}_{_safe_filename(source.name)}"
        shutil.copy2(source, dest)
        vertical = args.vertical or source.stem
        result = FirmService(settings).import_cv(
            profile_id=profile_id,
            vertical=vertical,
            filename=source.name,
            file_path=str(dest),
            mime=mimetypes.guess_type(source.name)[0] or "application/octet-stream",
            raw_text=raw,
        )
        print(f"Imported CV #{result['id']} [{vertical}] {source.name}")
        print(
            f"  parsed: {len(result['parsed']['experience'])} roles, "
            f"{len(result['parsed']['skills'])} skills, "
            f"{len(result['parsed']['education'])} education entries"
        )
        return 0

    if args.profile_command == "list-cvs":
        with db.session(settings.db_path) as conn:
            cvs = db.list_cvs(conn, profile_id)
        for cv in cvs:
            print(f"#{cv['id']} [{cv['vertical']}] {cv['filename']} ({len(cv['raw_text'])} chars)")
        return 0

    raise SystemExit("Unknown profile command")


def cmd_job(settings: Settings, args) -> int:
    db.init_db(settings.db_path)
    profile_id = _profile_id(settings)
    if args.job_command == "add":
        description = _read_description(args)
        if not description.strip():
            raise SystemExit("The job description is empty.")
        with db.session(settings.db_path) as conn:
            job_id = db.create_job(
                conn,
                profile_id=profile_id,
                title=args.title or "",
                company=args.company or "",
                description=description,
                source=args.file or ("stdin" if args.stdin else "text"),
                language=args.language or "",
            )
        print(f"Created job #{job_id}")
        if args.no_run:
            return 0
        return _run_job(settings, job_id)

    if args.job_command == "run":
        return _run_job(settings, args.id)

    if args.job_command == "list":
        with db.session(settings.db_path) as conn:
            jobs = db.list_jobs(conn)
        for job in jobs:
            print(
                f"#{job['id']:>3} {job['status']:<10} {job['title'] or '(untitled)':<38} "
                f"{job['company'] or '':<24} generated={job['generated_count']}"
            )
        return 0

    if args.job_command == "show":
        with db.session(settings.db_path) as conn:
            job = db.get_job(conn, args.id)
            if not job:
                raise SystemExit(f"Job {args.id} not found")
            analysis = db.latest_analysis(conn, args.id)
            generated = db.list_generated(conn, args.id)
        if args.json:
            print(json.dumps({"job": job, "analysis": analysis, "generated": generated}, indent=2, default=str))
            return 0
        print(f"Job #{job['id']}: {job['title']} @ {job['company']}")
        print(f"  status: {job['status']}")
        if job["error"]:
            print(f"  error: {job['error']}")
        if analysis:
            print(f"  match: {analysis['verdict']}")
            data = analysis["data"]
            for item in data.get("strengths", [])[:5]:
                print(f"    + {item.get('requirement', '')[:100]}")
            for item in data.get("gaps", [])[:5]:
                print(f"    - {item.get('requirement', '')[:100]}")
        for gen in generated:
            print(f"  generated #{gen['id']}: {gen['pdf_path']}")
            print(f"                     {gen['docx_path']}")
            if gen["warnings"]:
                print(f"    warnings: {len(gen['warnings'])}")
        return 0

    raise SystemExit("Unknown job command")


def _run_job(settings: Settings, job_id: int) -> int:
    print(f"Running tailoring for job #{job_id}...")
    try:
        result = FirmService(settings).tailor(job_id)
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"Done. Match score: {result['score']}/100")
    print(f"  PDF:  {result['pdf_path']}")
    print(f"  DOCX: {result['docx_path']}")
    if result["warnings"]:
        print(f"  grounding warnings: {len(result['warnings'])}")
        for warning in result["warnings"][:10]:
            print(f"    - {warning}")
    return 0


def cmd_serve(settings: Settings, args) -> int:
    import uvicorn

    from .api.app import create_app

    host = args.host or settings.host
    port = args.port or settings.port
    app = create_app(settings)
    print(f"Career Firm on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


def cmd_agents(settings: Settings, args) -> int:
    from .agents import prompts

    roles = {
        "office_manager": ("Office Manager", prompts.OFFICE_MANAGER),
        "headhunter": ("Headhunter", prompts.HEADHUNTER),
        "resume_writer": ("Resume Writer", prompts.RESUME_WRITER),
    }
    if args.prompt:
        if args.prompt not in roles:
            raise SystemExit(f"Unknown role. Choose: {', '.join(roles)}")
        print(roles[args.prompt][1])
        return 0
    for key, (label, prompt) in roles.items():
        print(f"{key:<18} {label:<18} {prompt.strip().splitlines()[0][:100]}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="career-firm",
        description="Agent-run career firm: import CVs, analyse jobs, generate ATS-ready tailored CVs.",
    )
    parser.add_argument("--home", help="Data directory (overrides CAREER_FIRM_HOME)")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Initialise the local database and data directories")
    sub.add_parser("config", help="Print the effective configuration")
    sub.add_parser("doctor", help="Check dependencies, provider, database, and fonts")

    profile = sub.add_parser("profile", help="Manage the client context and CV versions")
    profile_sub = profile.add_subparsers(dest="profile_command", required=True)
    profile_sub.add_parser("show", help="Show the profile and CV inventory")
    set_context = profile_sub.add_parser("set-context", help="Import the context file")
    set_context.add_argument("file")
    add_cv = profile_sub.add_parser("add-cv", help="Import a CV version")
    add_cv.add_argument("file")
    add_cv.add_argument("--vertical", help="Vertical label, e.g. 'AI Platforms' or 'Fintech'")
    profile_sub.add_parser("list-cvs", help="List CV versions")

    job = sub.add_parser("job", help="Add, run, and inspect job descriptions")
    job_sub = job.add_subparsers(dest="job_command", required=True)
    add_job = job_sub.add_parser("add", help="Create a job and run the tailoring workflow")
    add_job.add_argument("--file", help="Job description file (DOCX, PDF, TXT, MD) or - for stdin")
    add_job.add_argument("--text", help="Job description as text")
    add_job.add_argument("--stdin", action="store_true", help="Read the job description from stdin")
    add_job.add_argument("--title", default="")
    add_job.add_argument("--company", default="")
    add_job.add_argument("--language", default="")
    add_job.add_argument("--no-run", action="store_true", help="Create the job without running it")
    run_job = job_sub.add_parser("run", help="Run or re-run tailoring for a job")
    run_job.add_argument("id", type=int)
    job_sub.add_parser("list", help="List jobs")
    show_job = job_sub.add_parser("show", help="Show a job, analysis, and generated files")
    show_job.add_argument("id", type=int)
    show_job.add_argument("--json", action="store_true")

    serve = sub.add_parser("serve", help="Run the local web app")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)

    agents = sub.add_parser("agents", help="List agent roles or print a role prompt")
    agents.add_argument("--prompt", help="Print the full prompt for a role")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    if args.home:
        os.environ["CAREER_FIRM_HOME"] = args.home
    settings = _apply_stored_settings(Settings.load())
    if args.command == "init":
        return cmd_init(settings, args)
    if args.command == "config":
        return cmd_config(settings, args)
    if args.command == "doctor":
        return cmd_doctor(settings, args)
    if args.command == "profile":
        return cmd_profile(settings, args)
    if args.command == "job":
        return cmd_job(settings, args)
    if args.command == "agents":
        return cmd_agents(settings, args)
    if args.command == "serve":
        return cmd_serve(settings, args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
