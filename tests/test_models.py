from __future__ import annotations

from career_firm.models import JobAnalysis, ParsedCV, TailoredCV


def test_job_analysis_accepts_llm_shorthand():
    analysis = JobAnalysis.model_validate(
        {
            "must_haves": ["Lead engineering"],
            "nice_to_haves": "Cloud cost",
            "keywords": ["LLM", "Platform"],
            "score": "85%",
            "strengths": ["Scaled teams"],
            "gaps": ["Board reporting"],
            "recommended_cv": "2",
        }
    )
    assert analysis.must_have == ["Lead engineering"]
    assert analysis.nice_to_have == ["Cloud cost"]
    assert analysis.ats_keywords == ["LLM", "Platform"]
    assert analysis.match_score == 85
    assert analysis.strengths[0].requirement == "Scaled teams"
    assert analysis.gaps[0].requirement == "Board reporting"
    assert analysis.recommended_cv_id == 2


def test_tailored_cv_aliases_and_contact_fallback():
    cv = TailoredCV.model_validate(
        {
            "name": "Jane Doe",
            "professional_summary": "Executive.",
            "competencies": ["AI", "Platforms"],
            "keywords": ["LLM"],
            "email": "jane@example.com",
            "phone": "+1 555 0100",
            "experience": [
                {
                    "company": "Acme",
                    "title": "VP",
                    "dates": "2020 - Present",
                    "achievements": ["Led 45 engineers"],
                }
            ],
        }
    )
    assert cv.summary == "Executive."
    assert cv.core_competencies == ["AI", "Platforms"]
    assert cv.ats_keywords == ["LLM"]
    assert cv.contact.email == "jane@example.com"
    assert cv.experience[0].start == "2020"
    assert cv.experience[0].end == "Present"
    assert cv.experience[0].bullets == ["Led 45 engineers"]


def test_parsed_cv_accepts_shorthand():
    parsed = ParsedCV.model_validate(
        {
            "name": "Jane",
            "work_experience": [{"company": "Acme", "title": "VP", "dates": "2019 - 2024"}],
            "education_history": [{"institution": "Stanford", "degree": "MS"}],
            "professional_summary": "Executive.",
        }
    )
    assert parsed.summary == "Executive."
    assert parsed.experience[0].start == "2019"
    assert parsed.education[0].institution == "Stanford"
