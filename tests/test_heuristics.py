from __future__ import annotations

from resume_firm.agents.grounding import remove_unsupported_keywords, validate_grounding
from resume_firm.documents.heuristics import (
    analyze_job_heuristic,
    parse_cv_heuristic,
    tailor_heuristic,
)
from resume_firm.models import ContactInfo, ExperienceItem, JobAnalysis, TailoredCV


def test_parse_cv_heuristic_extracts_roles_and_identity(sample_cv):
    parsed = parse_cv_heuristic(sample_cv)
    assert parsed.name == "Jane Doe"
    assert parsed.headline == "VP Engineering | AI Platforms"
    assert parsed.contact.email == "jane.doe@example.com"
    assert len(parsed.experience) == 2
    first = parsed.experience[0]
    assert first.company == "Acme Corp"
    assert first.title == "VP Engineering"
    assert first.location == "San Francisco"
    assert first.start == "2020"
    assert first.end == "Present"
    assert len(first.bullets) == 3
    assert parsed.education[0].institution == "Stanford University"
    assert "Python" in parsed.skills


def test_analyze_job_heuristic_maps_evidence(sample_cv, sample_jd):
    parsed = parse_cv_heuristic(sample_cv)
    analysis = analyze_job_heuristic(sample_jd, sample_cv)
    assert analysis.job_title == "VP Engineering, AI Platform"
    assert analysis.company == "Nimbus AI"
    assert analysis.match_score >= 50
    assert analysis.match_level in {"strong", "moderate"}
    assert len(analysis.must_have) >= 2
    assert len(analysis.strengths) >= 1
    assert any("LLM" in item.evidence for item in analysis.strengths)
    assert "LLM" in analysis.ats_keywords or "llm" in analysis.ats_keywords


def test_evidence_joins_wrapped_lines_and_filters_keyword_noise():
    candidate = (
        "- Executive engineering leader focused on AI platforms, data infrastructure, and\n"
        "enterprise SaaS.\n"
    )
    job = (
        "Must have engineering leadership and platform experience.\n"
        "Nice to have 10+ years of cloud cost optimization.\n"
    )
    analysis = analyze_job_heuristic(job, candidate)
    assert analysis.strengths
    assert analysis.strengths[0].evidence == (
        "Executive engineering leader focused on AI platforms, data infrastructure, "
        "and enterprise SaaS."
    )
    assert all(not keyword.startswith("10") for keyword in analysis.ats_keywords)
    assert all(not keyword.endswith((" and", " company")) for keyword in analysis.ats_keywords)


def test_tailor_builds_clean_competencies(sample_cv):
    job = (
        "Head of AI Platform\n"
        "Must have LLM platforms and enterprise customers.\n"
        "Nice to have cloud cost optimization.\n"
        "Own the platform roadmap and drive revenue.\n"
    )
    parsed = parse_cv_heuristic(sample_cv)
    analysis = analyze_job_heuristic(job, sample_cv)
    tailored = tailor_heuristic(parsed, analysis, sample_cv, "")
    competencies = [item.lower() for item in tailored.core_competencies]
    assert competencies
    assert "head" not in competencies
    assert "own" not in competencies
    assert len(tailored.core_competencies) <= 12


def test_tailor_heuristic_preserves_facts(sample_cv, sample_jd):
    parsed = parse_cv_heuristic(sample_cv)
    analysis = analyze_job_heuristic(sample_jd, sample_cv)
    tailored = tailor_heuristic(parsed, analysis, sample_cv, "Executive leader.")
    assert [item.company for item in tailored.experience] == ["Acme Corp", "Beta Systems"]
    assert tailored.experience[0].start == "2020"
    assert "45" in " ".join(tailored.experience[0].bullets)
    warnings = validate_grounding(tailored, sample_cv, "Executive leader.", analysis)
    assert warnings == []


def test_grounding_flags_invented_company_and_metric():
    source = "Acme Corp\nLed a team of 5.\n2019 - 2020"
    analysis = JobAnalysis(do_not_claim=["Series C fundraising"])
    tailored = TailoredCV(
        name="Jane",
        contact=ContactInfo(email="jane@example.com"),
        summary="Series C fundraising expert.",
        experience=[
            ExperienceItem(
                company="Globex",
                title="VP",
                start="2018",
                end="2024",
                bullets=["Grew revenue 99%."],
            )
        ],
    )
    warnings = validate_grounding(tailored, source, "", analysis)
    joined = "\n".join(warnings)
    assert "Globex" in joined
    assert "99" in joined
    assert "2018" in joined
    assert "Series C" in joined


def test_remove_unsupported_keywords(sample_cv):
    cv = TailoredCV(ats_keywords=["LLM", "Blockchain", "Cloud"])
    cleaned = remove_unsupported_keywords(cv, sample_cv, "")
    assert "LLM" in cleaned.ats_keywords
    assert "Cloud" in cleaned.ats_keywords
    assert "Blockchain" not in cleaned.ats_keywords
