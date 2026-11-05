from __future__ import annotations

from ...config import Settings
from ...documents.heuristics import analyze_job_heuristic, candidate_digest
from ...llm.base import LLMClient
from ...llm.mock import MockClient
from ...models import JobAnalysis
from ..base import Agent, AgentSpec
from ..prompts import HEADHUNTER
from ..runner import record_heuristic_run, run_agent


class Headhunter:
    """Reads the job like a hiring committee and maps evidence to requirements."""

    role = "headhunter"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def analyze(
        self,
        *,
        job_description: str,
        context: str,
        cvs: list[dict],
        fallback_title: str = "",
        fallback_company: str = "",
        language: str = "en",
        workflow_run_id: int | None = None,
    ) -> JobAnalysis:
        digest = candidate_digest(context, cvs)
        if self.settings.is_mock or isinstance(self.llm, MockClient):
            analysis = analyze_job_heuristic(
                job_description,
                digest,
                cvs=cvs,
                fallback_title=fallback_title,
                fallback_company=fallback_company,
            )
            record_heuristic_run(
                self.settings,
                workflow="tailoring",
                role=self.role,
                input_payload={
                    "job_chars": len(job_description),
                    "cv_ids": [cv.get("id") for cv in cvs],
                },
                output=analysis.model_dump(),
                workflow_run_id=workflow_run_id,
            )
            return self._normalise(analysis, cvs, fallback_title, fallback_company, language)

        inventory = "\n".join(
            f"- CV ID {cv['id']} | vertical: {cv.get('vertical', '')} | file: {cv.get('filename', '')}"
            for cv in cvs
        )
        task = (
            "Analyse the job below for this client and return the JobAnalysis JSON.\n\n"
            f"## JOB DESCRIPTION\n{job_description.strip()}\n\n"
            f"## CV INVENTORY\n{inventory or '(no CVs imported)'}\n\n"
            f"## TARGET OUTPUT LANGUAGE\n{language}\n\n"
            "Use the exact CV IDs above in recommended_cv_id."
        )
        agent = Agent(
            AgentSpec(
                name="headhunter",
                role=self.role,
                system_prompt=HEADHUNTER,
                temperature=0.1,
            ),
            self.llm,
            self.settings,
        )
        try:
            result = run_agent(
                self.settings,
                agent,
                workflow="tailoring",
                role=self.role,
                task=task,
                context=digest,
                schema=JobAnalysis,
                workflow_run_id=workflow_run_id,
            )
            analysis = JobAnalysis.model_validate(result.data or {})
        except Exception as exc:
            if not self.settings.allow_heuristic_fallback:
                raise
            analysis = analyze_job_heuristic(
                job_description,
                digest,
                cvs=cvs,
                fallback_title=fallback_title,
                fallback_company=fallback_company,
            )
            analysis = analysis.model_copy(
                update={
                    "analyzer_notes": (
                        analysis.analyzer_notes
                        + f" Model analysis failed ({type(exc).__name__}); heuristic fallback used."
                    ).strip()
                }
            )

        return self._normalise(analysis, cvs, fallback_title, fallback_company, language)

    def _normalise(
        self,
        analysis: JobAnalysis,
        cvs: list[dict],
        fallback_title: str,
        fallback_company: str,
        language: str,
    ) -> JobAnalysis:
        updates: dict = {}
        if not analysis.job_title:
            updates["job_title"] = fallback_title
        if not analysis.company:
            updates["company"] = fallback_company
        if not analysis.language:
            updates["language"] = language

        ids = {int(cv["id"]) for cv in cvs}
        if analysis.recommended_cv_id not in ids:
            updates["recommended_cv_id"] = cvs[0]["id"] if cvs else None
        chosen = next(
            (cv for cv in cvs if int(cv["id"]) == updates.get("recommended_cv_id", analysis.recommended_cv_id)),
            None,
        )
        if chosen and not analysis.recommended_vertical:
            updates["recommended_vertical"] = chosen.get("vertical", "")

        score = max(0, min(100, int(analysis.match_score or 0)))
        updates["match_score"] = score
        if not analysis.match_level:
            updates["match_level"] = "strong" if score >= 75 else "moderate" if score >= 50 else "weak"
        if not analysis.do_not_claim:
            updates["do_not_claim"] = [gap.requirement for gap in analysis.gaps if gap.requirement]
        return analysis.model_copy(update=updates) if updates else analysis
