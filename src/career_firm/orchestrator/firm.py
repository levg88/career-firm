from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .. import db
from ..config import Settings
from ..documents.heuristics import detect_language, parse_cv_heuristic
from ..documents.render import render_cv
from ..llm import build_llm
from ..models import JobAnalysis, ParsedCV
from ..agents.office_manager import OfficeManager
from ..agents.headhunter import Headhunter
from ..agents.resume_writer import ResumeWriter


def _slug(value: str, fallback: str = "cv") -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value or "").strip("-")
    return value[:100] or fallback


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


class FirmService:
    """The dedicated career-firm workflow: import → analyse → write → render."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.office = OfficeManager(settings, self.llm)
        self.headhunter = Headhunter(settings, self.llm)
        self.writer = ResumeWriter(settings, self.llm)

    def import_cv(
        self,
        *,
        profile_id: int,
        vertical: str,
        filename: str,
        file_path: str,
        mime: str,
        raw_text: str,
    ) -> dict:
        parsed = self.office.parse_cv(raw_text, filename=filename)
        with db.session(self.settings.db_path) as conn:
            cv_id = db.add_cv(
                conn,
                profile_id=profile_id,
                vertical=vertical,
                filename=filename,
                file_path=file_path,
                mime=mime,
                raw_text=raw_text,
                structured_json=parsed.model_dump_json(),
            )
            cv = db.get_cv(conn, cv_id)
        return {"id": cv_id, "cv": cv, "parsed": parsed.model_dump()}

    def set_context(self, *, profile_id: int, text: str, filename: str | None) -> None:
        with db.session(self.settings.db_path) as conn:
            db.update_profile_context(conn, profile_id, text, filename)

    def tailor(self, job_id: int) -> dict:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with db.session(self.settings.db_path) as conn:
            job = db.get_job(conn, job_id)
            if not job:
                raise ValueError(f"Job {job_id} not found")
            profile = db.get_profile(conn, int(job["profile_id"] or 1))
            cvs = db.list_cvs(conn, int(job["profile_id"] or 1))
            workflow_id = db.create_workflow(
                conn,
                kind="tailor",
                title=f"{job['title'] or 'Role'} @ {job['company'] or 'Company'}",
                input_payload={"job_id": job_id},
                workspace_path=str(self.settings.runs_dir / f"tailor_{job_id}"),
            )
            db.update_workflow(conn, workflow_id, status="running")
            db.update_job(conn, job_id, status="analyzing", error=None)

        workspace = self.settings.runs_dir / f"tailor_{job_id}"
        workspace.mkdir(parents=True, exist_ok=True)
        try:
            if not cvs:
                raise ValueError("No CV versions are configured. Import at least one CV first.")
            context_text = (profile or {}).get("context_text", "") if profile else ""
            requested_language = (
                job["language"]
                or detect_language(job["description"])
                or self.settings.default_language
            )
            analysis: JobAnalysis = self.headhunter.analyze(
                job_description=job["description"],
                context=context_text,
                cvs=cvs,
                fallback_title=job["title"],
                fallback_company=job["company"],
                language=requested_language,
                workflow_run_id=workflow_id,
            )

            selected_cv = next(
                (cv for cv in cvs if int(cv["id"]) == int(analysis.recommended_cv_id or -1)),
                cvs[0],
            )
            if not analysis.recommended_cv_id:
                analysis = analysis.model_copy(update={"recommended_cv_id": selected_cv["id"]})
            if not analysis.recommended_vertical:
                analysis = analysis.model_copy(update={"recommended_vertical": selected_cv.get("vertical", "")})

            with db.session(self.settings.db_path) as conn:
                db.update_job(
                    conn,
                    job_id,
                    title=job["title"] or analysis.job_title,
                    company=job["company"] or analysis.company,
                    status="writing",
                )
                analysis_id = db.save_analysis(
                    conn,
                    job_id=job_id,
                    cv_version_id=selected_cv["id"],
                    score=analysis.match_score,
                    verdict=f"{analysis.match_level} ({analysis.match_score}/100)",
                    payload=analysis.model_dump(),
                )

            parsed = self._parsed_cv(selected_cv)
            language = job["language"] or analysis.language or self.settings.default_language
            tailored, warnings = self.writer.write(
                analysis=analysis,
                parsed=parsed,
                source_text=selected_cv.get("raw_text", ""),
                context=context_text,
                language=language,
                workflow_run_id=workflow_id,
            )

            with db.session(self.settings.db_path) as conn:
                db.update_job(conn, job_id, status="rendering")

            out_dir = self.settings.storage_dir / "generated" / f"job_{job_id}"
            basename = "_".join(
                part
                for part in (
                    _slug(tailored.name or "candidate", "candidate"),
                    _slug(analysis.company or "company", "company"),
                    _slug(analysis.job_title or f"job-{job_id}", "role"),
                    _stamp(),
                )
                if part
            )
            rendered = render_cv(
                tailored,
                out_dir,
                basename,
                font_path=self.settings.font_path or None,
            )

            with db.session(self.settings.db_path) as conn:
                generated_id = db.save_generated_cv(
                    conn,
                    job_id=job_id,
                    analysis_id=analysis_id,
                    language=language,
                    docx_path=rendered["docx_path"],
                    pdf_path=rendered["pdf_path"],
                    content=tailored.model_dump(),
                    warnings=warnings,
                )
                db.update_job(conn, job_id, status="done", error=None)
                db.update_workflow(
                    conn,
                    workflow_id,
                    status="done",
                    output_json=json.dumps(
                        {
                            "job_id": job_id,
                            "analysis_id": analysis_id,
                            "generated_id": generated_id,
                            "score": analysis.match_score,
                            "docx_path": rendered["docx_path"],
                            "pdf_path": rendered["pdf_path"],
                            "warnings": warnings,
                        },
                        ensure_ascii=False,
                    ),
                    finished_at=now,
                )

            return {
                "job_id": job_id,
                "workflow_id": workflow_id,
                "analysis_id": analysis_id,
                "generated_id": generated_id,
                "score": analysis.match_score,
                "docx_path": rendered["docx_path"],
                "pdf_path": rendered["pdf_path"],
                "warnings": warnings,
            }
        except Exception as exc:
            with db.session(self.settings.db_path) as conn:
                db.update_job(conn, job_id, status="failed", error=f"{type(exc).__name__}: {exc}")
                db.update_workflow(
                    conn,
                    workflow_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                    finished_at=now,
                )
            raise

    def _parsed_cv(self, cv: dict) -> ParsedCV:
        raw = cv.get("structured_json")
        if raw:
            try:
                parsed = ParsedCV.model_validate_json(raw)
                if parsed.name or parsed.experience:
                    return parsed
            except Exception:
                pass
        return parse_cv_heuristic(cv.get("raw_text", ""), fallback_name=Path(cv.get("filename", "")).stem)
