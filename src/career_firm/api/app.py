from __future__ import annotations

import json
import mimetypes
import os
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .. import db
from ..config import Settings, default_base_url_for, default_model_for
from ..documents.extract import ExtractionError, extract_text
from ..llm import build_llm
from ..llm.mock import MockClient
from ..orchestrator.firm import FirmService

ALLOWED_UPLOADS = {".docx", ".pdf", ".txt", ".md", ".markdown"}
IMAGE_TYPES = {"application/pdf"}


def _safe_filename(name: str) -> str:
    name = Path(name or "upload").name
    cleaned = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in name).strip()
    return cleaned[:120] or "upload"


def _save_upload(settings: Settings, subdir: str, name: str, data: bytes) -> Path:
    directory = settings.storage_dir / subdir
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid.uuid4().hex[:10]}_{_safe_filename(name)}"
    path.write_bytes(data)
    return path


async def _read_upload(upload: UploadFile, settings: Settings) -> tuple[str, bytes]:
    name = upload.filename or "upload"
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED_UPLOADS:
        raise ValueError(
            f"Unsupported file type '{suffix or 'unknown'}'. Use DOCX, PDF, TXT, or Markdown."
        )
    data = await upload.read()
    if not data:
        raise ValueError("The uploaded file is empty.")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise ValueError(f"File exceeds the {settings.max_upload_mb} MB limit.")
    return name, data


def _llm_note(settings: Settings) -> str:
    llm = build_llm(settings)
    if isinstance(llm, MockClient):
        if llm.reason:
            return f"Offline mode: {llm.reason}. Open Settings to choose a provider."
        return (
            "Offline mode. CVs are being tailored with deterministic rules. "
            "Open Settings to add a provider and API key."
        )
    return ""


def _current_base_url(settings: Settings) -> str:
    return settings.active_base_url


def _profile(settings: Settings) -> dict:
    with db.session(settings.db_path) as conn:
        return db.get_or_create_profile(conn)


def _run_tailor(settings: Settings, job_id: int) -> None:
    try:
        FirmService(settings).tailor(job_id)
    except Exception:
        # The service records the failure on the job and workflow.
        pass


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.load()
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    with db.session(settings.db_path) as conn:
        stored = db.get_app_settings(conn)
    if stored:
        settings.apply_config(stored)
    try:
        os.chmod(settings.db_path, 0o600)
    except OSError:
        pass

    app = FastAPI(title="Career Firm", version="0.2.0")
    app.state.settings = settings

    base = Path(__file__).parent
    templates = Jinja2Templates(directory=str(base / "templates"))
    app.mount("/static", StaticFiles(directory=str(base / "static")), name="static")

    @app.middleware("http")
    async def require_setup(request: Request, call_next):
        path = request.url.path
        if not settings.setup_complete and not (
            path in {"/setup", "/health", "/favicon.ico"} or path.startswith("/static/")
        ):
            return RedirectResponse("/setup", status_code=303)
        return await call_next(request)

    def page(request: Request, name: str, status_code: int = 200, **context):
        profile = _profile(settings)
        with db.session(settings.db_path) as conn:
            cvs = db.list_cvs(conn, profile["id"])
            stats = db.stats(conn)
        context.setdefault("profile", profile)
        context.setdefault("cv_count", len(cvs))
        context.setdefault("stats", stats)
        context.setdefault("llm_note", _llm_note(settings))
        context.setdefault("settings", settings)
        context.setdefault("active", "")
        return templates.TemplateResponse(request, name, context, status_code=status_code)

    def setup_page(request: Request, *, editing: bool, error: str = "", message: str = ""):
        profile = _profile(settings)
        with db.session(settings.db_path) as conn:
            cvs = db.list_cvs(conn, profile["id"], active_only=False)
        return page(
            request,
            "setup.html",
            editing=editing,
            cvs=cvs,
            base_url=_current_base_url(settings),
            suggested_models={
                provider: default_model_for(provider)
                for provider in ("openai", "anthropic", "ollama", "opencode", "mock")
            },
            suggested_base_urls={
                provider: default_base_url_for(provider)
                for provider in ("openai", "anthropic", "ollama", "opencode")
            },
            error=error,
            message=message,
            active="settings",
            llm_note="",
        )

    @app.get("/setup", response_class=HTMLResponse)
    def setup_view(request: Request, message: str = "", error: str = ""):
        return setup_page(
            request,
            editing=settings.setup_complete,
            error=error,
            message=message,
        )

    @app.get("/settings", response_class=HTMLResponse)
    def settings_view(request: Request, message: str = "", error: str = ""):
        return setup_page(request, editing=True, error=error, message=message)

    @app.post("/setup")
    @app.post("/settings")
    async def save_configuration(
        request: Request,
        provider: str = Form("mock"),
        model: str = Form(""),
        api_key: str = Form(""),
        clear_key: str = Form(""),
        base_url: str = Form(""),
        default_language: str = Form("en"),
        temperature: str = Form("0.2"),
        max_tokens: str = Form("8192"),
        max_agent_steps: str = Form("12"),
        max_upload_mb: str = Form("15"),
        allow_heuristic_fallback: str = Form(""),
        font_path: str = Form(""),
        context_text: str = Form(""),
        vertical: str = Form(""),
        context_file: UploadFile | None = File(None),
        cv_file: UploadFile | None = File(None),
    ):
        editing = settings.setup_complete
        provider = provider.strip().lower()
        if provider not in {"openai", "anthropic", "ollama", "opencode", "mock"}:
            return setup_page(
                request,
                editing=editing,
                error="Choose a valid provider.",
            )

        key_cleared = clear_key.strip().lower() in {"1", "true", "yes", "on"}
        entered_key = "" if key_cleared else api_key.strip()
        existing_key = (
            settings.anthropic_api_key
            if provider == "anthropic"
            else settings.opencode_api_key
            if provider == "opencode"
            else settings.api_key
        )
        effective_key = entered_key or existing_key
        if provider == "openai" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An OpenAI API key is required. Choose Offline mode if you do not have one.",
            )
        if provider == "anthropic" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An Anthropic API key is required. Choose Offline mode if you do not have one.",
            )
        if provider == "opencode" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An OpenCode API key is required. Choose Offline mode if you do not have one.",
            )

        resolved_base = base_url.strip() or default_base_url_for(provider)
        updates: dict[str, str] = {
            "provider": provider,
            "model": model.strip() or default_model_for(provider),
            "default_language": default_language.strip() or "en",
            "temperature": temperature,
            "max_tokens": max_tokens,
            "max_agent_steps": max_agent_steps,
            "max_upload_mb": max_upload_mb,
            "allow_heuristic_fallback": (
                "true"
                if allow_heuristic_fallback.strip().lower() in {"1", "true", "yes", "on"}
                else "false"
            ),
            "font_path": font_path.strip(),
        }
        if provider == "anthropic":
            updates["anthropic_base_url"] = resolved_base
        elif provider == "ollama":
            updates["ollama_base_url"] = resolved_base
        elif provider == "opencode":
            updates["opencode_base_url"] = resolved_base
        else:
            updates["base_url"] = resolved_base

        if key_cleared:
            updates["api_key"] = ""
            updates["anthropic_api_key"] = ""
            updates["opencode_api_key"] = ""
        elif entered_key:
            if provider == "anthropic":
                updates["anthropic_api_key"] = entered_key
            elif provider == "opencode":
                updates["opencode_api_key"] = entered_key
            elif provider in {"openai", "ollama"}:
                updates["api_key"] = entered_key

        settings.apply_config(updates)
        settings.setup_complete = True
        with db.session(settings.db_path) as conn:
            db.save_app_settings(conn, settings.config_values(include_secrets=True))

        try:
            if context_file is not None and context_file.filename:
                name, data = await _read_upload(context_file, settings)
                path = _save_upload(settings, "context", name, data)
                raw = extract_text(path)
                FirmService(settings).set_context(
                    profile_id=_profile(settings)["id"], text=raw, filename=name
                )
            elif context_text.strip():
                FirmService(settings).set_context(
                    profile_id=_profile(settings)["id"],
                    text=context_text.strip(),
                    filename="pasted-context",
                )

            if cv_file is not None and cv_file.filename:
                profile = _profile(settings)
                name, data = await _read_upload(cv_file, settings)
                path = _save_upload(settings, f"cvs/profile_{profile['id']}", name, data)
                raw = extract_text(path)
                FirmService(settings).import_cv(
                    profile_id=profile["id"],
                    vertical=vertical.strip() or Path(name).stem,
                    filename=name,
                    file_path=str(path),
                    mime=mimetypes.guess_type(name)[0] or "application/octet-stream",
                    raw_text=raw,
                )
        except (ValueError, ExtractionError) as exc:
            return setup_page(
                request,
                editing=editing,
                error=f"Configuration saved, but the upload failed: {exc}",
            )

        if editing:
            return RedirectResponse("/settings?message=Configuration+saved", status_code=303)
        return RedirectResponse("/?welcome=1", status_code=303)

    @app.get("/", response_class=HTMLResponse)
    def index(request: Request):
        with db.session(settings.db_path) as conn:
            jobs = db.list_jobs(conn, limit=12)
        message = (
            "Setup complete. Import another CV version or paste a job description to begin."
            if request.query_params.get("welcome") == "1"
            else ""
        )
        return page(request, "index.html", jobs=jobs, active="home", message=message)

    @app.get("/health")
    def health():
        with db.session(settings.db_path) as conn:
            return {
                "ok": True,
                "setup_complete": settings.setup_complete,
                "provider": settings.provider,
                "model": settings.model,
                "stats": db.stats(conn),
            }

    # ── profile ─────────────────────────────────────────────────────────────
    def profile_page(request: Request, error: str = "", message: str = "", status_code: int = 200):
        profile = _profile(settings)
        with db.session(settings.db_path) as conn:
            cvs = db.list_cvs(conn, profile["id"], active_only=False)
        return page(
            request,
            "profile.html",
            status_code=status_code,
            cvs=cvs,
            error=error,
            message=message,
            active="profile",
        )

    @app.get("/profile", response_class=HTMLResponse)
    def profile_view(request: Request, message: str = "", error: str = ""):
        return profile_page(request, error=error, message=message)

    @app.post("/profile/context")
    async def save_context(
        request: Request,
        text: str = Form(""),
        file: UploadFile | None = File(None),
    ):
        profile = _profile(settings)
        try:
            if file is not None and file.filename:
                name, data = await _read_upload(file, settings)
                path = _save_upload(settings, "context", name, data)
                raw = extract_text(path)
                FirmService(settings).set_context(
                    profile_id=profile["id"], text=raw, filename=name
                )
            elif text.strip():
                FirmService(settings).set_context(
                    profile_id=profile["id"], text=text.strip(), filename="pasted-context"
                )
            else:
                raise ValueError("Paste context text or upload a file.")
        except (ValueError, ExtractionError) as exc:
            return profile_page(request, error=str(exc), status_code=400)
        return RedirectResponse("/profile?message=Context+saved", status_code=303)

    @app.post("/profile/cvs")
    async def add_cv(
        request: Request,
        vertical: str = Form(""),
        file: UploadFile = File(...),
    ):
        profile = _profile(settings)
        try:
            name, data = await _read_upload(file, settings)
            path = _save_upload(settings, f"cvs/profile_{profile['id']}", name, data)
            raw = extract_text(path)
            FirmService(settings).import_cv(
                profile_id=profile["id"],
                vertical=vertical.strip() or Path(name).stem,
                filename=name,
                file_path=str(path),
                mime=mimetypes.guess_type(name)[0] or "application/octet-stream",
                raw_text=raw,
            )
        except (ValueError, ExtractionError) as exc:
            return profile_page(request, error=str(exc), status_code=400)
        except Exception as exc:
            return profile_page(request, error=f"Import failed: {exc}", status_code=400)
        return RedirectResponse("/profile?message=CV+imported", status_code=303)

    @app.post("/profile/cvs/{cv_id}/delete")
    def delete_cv(cv_id: int):
        with db.session(settings.db_path) as conn:
            db.deactivate_cv(conn, cv_id)
        return RedirectResponse("/profile?message=CV+deactivated", status_code=303)

    # ── jobs ────────────────────────────────────────────────────────────────
    @app.get("/jobs", response_class=HTMLResponse)
    def jobs_list(request: Request):
        with db.session(settings.db_path) as conn:
            jobs = db.list_jobs(conn, limit=200)
        return page(request, "jobs.html", jobs=jobs, active="jobs")

    @app.get("/jobs/new", response_class=HTMLResponse)
    def job_new(request: Request):
        return page(request, "job_new.html", active="new")

    @app.post("/jobs")
    async def create_job(
        request: Request,
        background: BackgroundTasks,
        description: str = Form(""),
        title: str = Form(""),
        company: str = Form(""),
        language: str = Form(""),
        jd_file: UploadFile | None = File(None),
    ):
        profile = _profile(settings)
        try:
            if jd_file is not None and jd_file.filename:
                name, data = await _read_upload(jd_file, settings)
                path = _save_upload(settings, f"jobs/profile_{profile['id']}", name, data)
                jd = extract_text(path)
            else:
                jd = description
            if not jd.strip():
                raise ValueError("Paste a job description or upload a file.")
        except (ValueError, ExtractionError) as exc:
            return page(
                request,
                "job_new.html",
                error=str(exc),
                form={"description": description, "title": title, "company": company},
                active="new",
                status_code=400,
            )

        with db.session(settings.db_path) as conn:
            job_id = db.create_job(
                conn,
                profile_id=profile["id"],
                title=title.strip(),
                company=company.strip(),
                description=jd.strip(),
                source=(jd_file.filename if jd_file and jd_file.filename else "pasted"),
                language=language.strip(),
            )
        background.add_task(_run_tailor, settings, job_id)
        return RedirectResponse(f"/jobs/{job_id}", status_code=303)

    @app.get("/jobs/{job_id}", response_class=HTMLResponse)
    def job_detail(request: Request, job_id: int):
        with db.session(settings.db_path) as conn:
            job = db.get_job(conn, job_id)
            if not job:
                raise HTTPException(status_code=404, detail="Job not found")
            analysis = db.latest_analysis(conn, job_id)
            generated = db.list_generated(conn, job_id)
            workflows = [
                w for w in db.list_workflows(conn, limit=50)
                if w["kind"] == "tailor" and w["input"].get("job_id") == job_id
            ]
        analysis_json = json.dumps(analysis["data"], indent=2, ensure_ascii=False) if analysis else ""
        return page(
            request,
            "job_detail.html",
            job=job,
            analysis=analysis,
            analysis_json=analysis_json,
            generated=generated,
            workflows=workflows,
            active="jobs",
        )

    @app.get("/jobs/{job_id}/status")
    def job_status(job_id: int):
        with db.session(settings.db_path) as conn:
            job = db.get_job(conn, job_id)
            if not job:
                raise HTTPException(status_code=404, detail="Job not found")
            generated = db.list_generated(conn, job_id)
        return JSONResponse(
            {
                "id": job["id"],
                "status": job["status"],
                "error": job["error"],
                "generated": [
                    {
                        "id": item["id"],
                        "pdf": f"/generated/{item['id']}/download/pdf",
                        "docx": f"/generated/{item['id']}/download/docx",
                    }
                    for item in generated
                ],
            }
        )

    @app.get("/generated/{generated_id}/download/{fmt}")
    def download(generated_id: int, fmt: str):
        if fmt not in {"pdf", "docx"}:
            raise HTTPException(status_code=400, detail="Format must be pdf or docx")
        with db.session(settings.db_path) as conn:
            generated = db.get_generated(conn, generated_id)
        if not generated:
            raise HTTPException(status_code=404, detail="Generated CV not found")
        path = Path(generated[f"{fmt}_path"])
        if not path.is_file():
            raise HTTPException(status_code=404, detail="File is missing on disk")
        return FileResponse(
            path,
            media_type=(
                "application/pdf"
                if fmt == "pdf"
                else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
            filename=path.name,
        )

    # ── audit trail ───────────────────────────────────────────────────────────
    @app.get("/runs", response_class=HTMLResponse)
    def runs(request: Request):
        with db.session(settings.db_path) as conn:
            workflows = db.list_workflows(conn, limit=40)
            agent_runs = db.list_agent_runs(conn, limit=80)
        return page(
            request,
            "runs.html",
            workflows=workflows,
            agent_runs=agent_runs,
            active="runs",
        )

    return app
