from __future__ import annotations

from ...config import Settings
from ...documents.heuristics import tailor_heuristic
from ...llm.base import LLMClient
from ...llm.mock import MockClient
from ...models import JobAnalysis, ParsedCV, TailoredCV
from ..base import Agent, AgentSpec
from ..grounding import remove_unsupported_keywords, validate_grounding
from ..prompts import RESUME_WRITER
from ..runner import record_heuristic_run, run_agent


class ResumeWriter:
    """Elite executive resume writer with a deterministic grounding check."""

    role = "resume_writer"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def write(
        self,
        *,
        analysis: JobAnalysis,
        parsed: ParsedCV,
        source_text: str,
        context: str,
        language: str,
        workflow_run_id: int | None = None,
    ) -> tuple[TailoredCV, list[str]]:
        if self.settings.is_mock or isinstance(self.llm, MockClient):
            cv = tailor_heuristic(parsed, analysis, source_text, context, language)
            warnings = validate_grounding(cv, source_text, context, analysis)
            cv = remove_unsupported_keywords(cv, source_text, context)
            record_heuristic_run(
                self.settings,
                workflow="tailoring",
                role=self.role,
                input_payload={
                    "analysis_score": analysis.match_score,
                    "source_chars": len(source_text),
                },
                output={"tailored_cv": cv.model_dump(), "warnings": warnings},
                workflow_run_id=workflow_run_id,
            )
            return cv, warnings

        task = (
            "Write the tailored CV for this role. Use the analysis and the source CV below.\n\n"
            f"## TARGET LANGUAGE\n{language}\n\n"
            "## HEADHUNTER ANALYSIS\n"
            f"{analysis.model_dump_json(indent=2)}\n\n"
            "## SOURCE CV (AUTHORITATIVE — do not add facts)\n"
            f"{parsed.model_dump_json(indent=2)}\n\n"
            "## ORIGINAL SOURCE TEXT (for exact wording and metrics)\n"
            f"{source_text[:24000]}"
        )
        agent = Agent(
            AgentSpec(
                name="resume_writer",
                role=self.role,
                system_prompt=RESUME_WRITER,
                temperature=0.25,
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
                context=context,
                schema=TailoredCV,
                workflow_run_id=workflow_run_id,
            )
            cv = TailoredCV.model_validate(result.data or {})
        except Exception as exc:
            if not self.settings.allow_heuristic_fallback:
                raise
            cv = tailor_heuristic(parsed, analysis, source_text, context, language)
            cv.change_log.append(
                f"Model writing failed ({type(exc).__name__}); deterministic tailoring fallback used."
            )

        cv = self._normalise(cv, parsed, language)
        cv = remove_unsupported_keywords(cv, source_text, context)
        warnings = validate_grounding(cv, source_text, context, analysis)
        return cv, warnings

    def _normalise(self, cv: TailoredCV, parsed: ParsedCV, language: str) -> TailoredCV:
        updates: dict = {}
        if not cv.name:
            updates["name"] = parsed.name
        if not cv.headline:
            updates["headline"] = parsed.headline
        if not cv.summary:
            updates["summary"] = parsed.summary
        if not cv.language:
            updates["language"] = language

        contact = cv.contact
        contact_updates = {
            "email": contact.email or parsed.contact.email,
            "phone": contact.phone or parsed.contact.phone,
            "location": contact.location or parsed.contact.location,
            "linkedin": contact.linkedin or parsed.contact.linkedin,
            "website": contact.website or parsed.contact.website,
        }
        if contact_updates != contact.model_dump():
            updates["contact"] = contact_updates

        if not cv.experience and parsed.experience:
            updates["experience"] = parsed.experience
        elif len(cv.experience) == len(parsed.experience):
            # Fill any fields the writer omitted, without overwriting its choices.
            merged = []
            for generated, source in zip(cv.experience, parsed.experience):
                merged.append(
                    generated.model_copy(
                        update={
                            "company": generated.company or source.company,
                            "title": generated.title or source.title,
                            "start": generated.start or source.start,
                            "end": generated.end or source.end,
                            "location": generated.location or source.location,
                        }
                    )
                )
            updates["experience"] = merged

        if not cv.education and parsed.education:
            updates["education"] = parsed.education
        if not cv.certifications and parsed.certifications:
            updates["certifications"] = parsed.certifications
        if not cv.skills and parsed.skills:
            updates["skills"] = parsed.skills
        if not cv.languages and parsed.languages:
            updates["languages"] = parsed.languages
        if not cv.change_log:
            updates["change_log"] = ["Tailored from the selected source CV; facts preserved."]

        return cv.model_copy(update=updates) if updates else cv
