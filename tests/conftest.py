from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from career_firm import db
from career_firm.config import Settings

SAMPLE_CV = """Jane Doe
VP Engineering | AI Platforms
jane.doe@example.com | +1 415 555 0123 | linkedin.com/in/janedoe

SUMMARY
Engineering executive with 15 years building AI and data platforms.

EXPERIENCE
Acme Corp | VP Engineering | San Francisco | 2020 - Present
• Led a team of 45 engineers and grew platform revenue 32%.
• Launched an LLM platform used by 120 enterprise customers.
• Cut cloud spend by $2.4M annually.

Beta Systems | Director of Engineering | 2015 - 2020
• Built a data platform processing 5 billion events per day.
• Scaled the team from 8 to 30 engineers.

EDUCATION
Stanford University | MS Computer Science | 2008

SKILLS
AI, LLM, Platform Engineering, Cloud, Kubernetes, Python

CERTIFICATIONS
AWS Solutions Architect
"""

SAMPLE_JD = """VP Engineering, AI Platform
Company: Nimbus AI

We are hiring a VP Engineering to lead our AI platform.

Must have 10+ years of engineering leadership and experience scaling teams.
Must have experience with LLM platforms and enterprise customers.
Nice to have cloud cost optimization.

Responsibilities:
- Lead the engineering organisation.
- Build the platform roadmap and drive revenue.
"""


@pytest.fixture
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("CAREER_FIRM_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("CAREER_FIRM_PROVIDER", "mock")
    monkeypatch.setenv("CAREER_FIRM_MODEL", "mock")
    monkeypatch.setenv("CAREER_FIRM_HEURISTIC_FALLBACK", "true")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = Settings.load()
    db.init_db(settings.db_path)
    return settings


@pytest.fixture
def profile_id(settings: Settings) -> int:
    with db.session(settings.db_path) as conn:
        return int(db.get_or_create_profile(conn)["id"])


@pytest.fixture
def sample_cv() -> str:
    return SAMPLE_CV


@pytest.fixture
def sample_jd() -> str:
    return SAMPLE_JD
