from __future__ import annotations

from pathlib import Path

from ...config import Settings
from ...documents.heuristics import parse_cv_heuristic
from ...llm.base import LLMClient
from ...llm.mock import MockClient
from ...models import ParsedCV
from ..base import Agent, AgentSpec
from ..prompts import OFFICE_MANAGER
from ..runner import record_heuristic_run, run_agent


class OfficeManager:
    """Reads the client's CVs and context, and keeps the record faithful."""

    role = "office_manager"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def parse_cv(
        self,
        text: str,
        *,
        filename: str = "",
        workflow_run_id: int | None = None,
    ) -> ParsedCV:
        fallback_name = Path(filename).stem.replace("_", " ").replace("-", " ").strip()
        fallback_name = fallback_name[:80] if fallback_name else ""

        if self.settings.is_mock or isinstance(self.llm, MockClient):
            parsed = parse_cv_heuristic(text, fallback_name=fallback_name)
            record_heuristic_run(
                self.settings,
                workflow="office_manager",
                role=self.role,
                input_payload={"filename": filename, "chars": len(text)},
                output=parsed.model_dump(),
                workflow_run_id=workflow_run_id,
            )
            return parsed

        agent = Agent(
            AgentSpec(
                name="office_manager",
                role=self.role,
                system_prompt=OFFICE_MANAGER,
                temperature=0.0,
            ),
            self.llm,
            self.settings,
        )
        task = (
            f"Parse the CV in the CONTEXT section into the ParsedCV schema. "
            f"Filename: {filename or 'unknown'}. "
            "If the name cannot be determined, use the filename stem only as a last resort."
        )
        try:
            result = run_agent(
                self.settings,
                agent,
                workflow="office_manager",
                role=self.role,
                task=task,
                context=text,
                schema=ParsedCV,
                workflow_run_id=workflow_run_id,
            )
            parsed = ParsedCV.model_validate(result.data or {})
        except Exception as exc:
            if not self.settings.allow_heuristic_fallback:
                raise
            parsed = parse_cv_heuristic(text, fallback_name=fallback_name)
            note = f"Structured parse fallback used ({type(exc).__name__})."
            parsed = parsed.model_copy(
                update={"summary": (parsed.summary + "\n\n" + note).strip()}
            )

        if not parsed.name:
            parsed = parsed.model_copy(update={"name": fallback_name})
        return parsed

    def build_profile_context(self, context_text: str, cvs: list[dict]) -> str:
        """A compact, factual profile digest for downstream agents."""
        parts = ["# CLIENT CONTEXT\n" + context_text.strip()]
        parts.append("\n# CV INVENTORY")
        for cv in cvs:
            parts.append(
                f"- CV ID {cv['id']} | vertical: {cv.get('vertical', '')} | "
                f"file: {cv.get('filename', '')}"
            )
        return "\n".join(parts)
