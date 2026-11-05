from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _as_list(value: Any) -> list[str]:
    """LLMs occasionally return a string, dict of lists, or list of objects."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, dict):
        out: list[str] = []
        for key, item in value.items():
            if isinstance(item, list):
                out.extend(f"{key}: {x}" for x in item if str(x).strip())
            elif str(item).strip():
                out.append(f"{key}: {item}")
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            if isinstance(item, dict):
                out.append(
                    str(
                        item.get("text")
                        or item.get("name")
                        or item.get("requirement")
                        or item
                    )
                )
            elif str(item).strip():
                out.append(str(item).strip())
        return out
    return [str(value)]


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return str(value)
    return str(value).strip()


class ContactInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    website: str = ""

    @field_validator("*", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)


class ExperienceItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    company: str = ""
    title: str = ""
    location: str = ""
    start: str = ""
    end: str = ""
    context: str = ""
    bullets: list[str] = Field(default_factory=list)

    @field_validator("bullets", mode="before")
    @classmethod
    def _bullets(cls, value: Any) -> list[str]:
        return _as_list(value)

    @field_validator("company", "title", "location", "start", "end", "context", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)

    @model_validator(mode="before")
    @classmethod
    def _aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if not data.get("start") and data.get("dates"):
            dates = str(data["dates"])
            if "–" in dates or " - " in dates:
                sep = "–" if "–" in dates else " - "
                start, end = dates.split(sep, 1)
                data.setdefault("start", start.strip())
                data.setdefault("end", end.strip())
        data.setdefault("bullets", data.get("achievements") or data.get("highlights"))
        return data


class EducationItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    institution: str = ""
    degree: str = ""
    location: str = ""
    year: str = ""
    details: str = ""

    @field_validator("*", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)


class ParsedCV(BaseModel):
    """Canonical, fact-preserving view of one source CV."""

    model_config = ConfigDict(extra="ignore")

    name: str = ""
    headline: str = ""
    contact: ContactInfo = Field(default_factory=ContactInfo)
    summary: str = ""
    experience: list[ExperienceItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    achievements: list[str] = Field(default_factory=list)

    @field_validator("skills", "certifications", "languages", "achievements", mode="before")
    @classmethod
    def _lists(cls, value: Any) -> list[str]:
        return _as_list(value)

    @field_validator("name", "headline", "summary", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)

    @model_validator(mode="before")
    @classmethod
    def _aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if "experience" not in data:
            data["experience"] = data.get("work_experience") or data.get("positions")
        if "education" not in data:
            data["education"] = data.get("education_history")
        if "summary" not in data:
            data["summary"] = data.get("professional_summary") or data.get("profile")
        return data


class Evidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    requirement: str = ""
    evidence: str = ""
    source: str = ""

    @field_validator("*", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)


class Gap(BaseModel):
    model_config = ConfigDict(extra="ignore")

    requirement: str = ""
    severity: str = "medium"
    mitigation: str = ""

    @field_validator("*", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)


class JobAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore")

    job_title: str = ""
    company: str = ""
    location: str = ""
    seniority: str = ""
    language: str = "en"
    summary: str = ""
    must_have: list[str] = Field(default_factory=list)
    nice_to_have: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    ats_keywords: list[str] = Field(default_factory=list)
    culture_signals: list[str] = Field(default_factory=list)
    red_flags: list[str] = Field(default_factory=list)
    match_score: int = 0
    match_level: str = ""
    strengths: list[Evidence] = Field(default_factory=list)
    gaps: list[Gap] = Field(default_factory=list)
    recommended_cv_id: int | None = None
    recommended_vertical: str = ""
    tailoring_plan: list[str] = Field(default_factory=list)
    keywords_to_include: list[str] = Field(default_factory=list)
    do_not_claim: list[str] = Field(default_factory=list)
    analyzer_notes: str = ""

    @field_validator(
        "must_have",
        "nice_to_have",
        "responsibilities",
        "ats_keywords",
        "culture_signals",
        "red_flags",
        "tailoring_plan",
        "keywords_to_include",
        "do_not_claim",
        mode="before",
    )
    @classmethod
    def _lists(cls, value: Any) -> list[str]:
        return _as_list(value)

    @field_validator("job_title", "company", "location", "seniority", "language", "summary", "match_level", "recommended_vertical", "analyzer_notes", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)

    @field_validator("match_score", mode="before")
    @classmethod
    def _score(cls, value: Any) -> int:
        if value is None or value == "":
            return 0
        if isinstance(value, str):
            value = value.strip().rstrip("%")
        try:
            return max(0, min(100, int(float(value))))
        except (TypeError, ValueError):
            return 0

    @field_validator("recommended_cv_id", mode="before")
    @classmethod
    def _cv_id(cls, value: Any) -> int | None:
        if value in (None, "", "null", "None", 0, "0"):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @field_validator("strengths", "gaps", mode="before")
    @classmethod
    def _objects(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            out = []
            for item in value:
                if isinstance(item, BaseModel):
                    out.append(item.model_dump())
                elif isinstance(item, str):
                    out.append({"requirement": item})
                elif isinstance(item, dict):
                    out.append(item)
            return out
        return value

    @model_validator(mode="before")
    @classmethod
    def _aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)
        aliases = {
            "must_haves": "must_have",
            "nice_to_haves": "nice_to_have",
            "keywords": "ats_keywords",
            "score": "match_score",
            "match": "match_score",
            "recommended_cv": "recommended_cv_id",
            "vertical": "recommended_vertical",
        }
        for old, new in aliases.items():
            if new not in data and old in data:
                data[new] = data[old]
        if "strengths" in data and isinstance(data["strengths"], list):
            data["strengths"] = [
                {"requirement": x} if isinstance(x, str) else x
                for x in data["strengths"]
            ]
        if "gaps" in data and isinstance(data["gaps"], list):
            data["gaps"] = [
                {"requirement": x} if isinstance(x, str) else x for x in data["gaps"]
            ]
        return data


class TailoredCV(BaseModel):
    model_config = ConfigDict(extra="ignore")

    language: str = "en"
    name: str = ""
    headline: str = ""
    contact: ContactInfo = Field(default_factory=ContactInfo)
    summary: str = ""
    core_competencies: list[str] = Field(default_factory=list)
    experience: list[ExperienceItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    ats_keywords: list[str] = Field(default_factory=list)
    change_log: list[str] = Field(default_factory=list)
    grounding: list[Evidence] = Field(default_factory=list)

    @field_validator(
        "core_competencies",
        "certifications",
        "skills",
        "languages",
        "ats_keywords",
        "change_log",
        mode="before",
    )
    @classmethod
    def _lists(cls, value: Any) -> list[str]:
        return _as_list(value)

    @field_validator("language", "name", "headline", "summary", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)

    @model_validator(mode="before")
    @classmethod
    def _aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if not data.get("summary"):
            data["summary"] = data.get("professional_summary")
        if not data.get("core_competencies"):
            data["core_competencies"] = data.get("competencies")
        if not data.get("ats_keywords"):
            data["ats_keywords"] = data.get("keywords")
        if not data.get("contact"):
            data["contact"] = {
                k: data.get(k, "")
                for k in ("email", "phone", "location", "linkedin", "website")
            }
        return data
