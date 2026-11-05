from __future__ import annotations

import math
import re
from collections import Counter

from ..models import (
    ContactInfo,
    EducationItem,
    Evidence,
    ExperienceItem,
    Gap,
    JobAnalysis,
    ParsedCV,
    TailoredCV,
)
from .extract import clean_text

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}")
_LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/(?:in|pub)/[\w\-/?=&%.]+", re.I)
_YEAR_RANGE_RE = re.compile(
    r"((?:19|20)\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(?:19|20)\d{2})"
    r"\s*[-–—]\s*"
    r"((?:19|20)\d{2}|present|current|now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(?:19|20)\d{2})",
    re.I,
)

TITLE_WORDS = {
    "director", "vp", "vice", "president", "chief", "head", "manager", "lead",
    "leader", "engineer", "engineering", "architect", "scientist", "analyst",
    "consultant", "officer", "founder", "partner", "principal", "staff",
    "senior", "junior", "associate", "specialist", "coordinator", "developer",
    "designer", "strategist", "advisor", "counsel", "controller", "accountant",
    "supervisor", "superintendent", "administrator", "producer", "editor",
}

COMPANY_WORDS = {
    "inc", "llc", "ltd", "corp", "corporation", "company", "group", "systems",
    "technologies", "technology", "solutions", "labs", "partners", "university",
    "bank", "foundation", "agency", "consulting", "ventures", "capital",
    "holdings", "industries", "services", "associates", "institute", "media",
    "networks", "software", "health", "global", "international",
}


SECTION_MAP = {
    "summary": "summary",
    "profile": "summary",
    "professional summary": "summary",
    "executive summary": "summary",
    "objective": "summary",
    "about": "summary",
    "about me": "summary",
    "experience": "experience",
    "professional experience": "experience",
    "work experience": "experience",
    "employment": "experience",
    "employment history": "experience",
    "work history": "experience",
    "career history": "experience",
    "education": "education",
    "academic background": "education",
    "skills": "skills",
    "core competencies": "skills",
    "competencies": "skills",
    "expertise": "skills",
    "areas of expertise": "skills",
    "technical skills": "skills",
    "certifications": "certifications",
    "certificates": "certifications",
    "licenses": "certifications",
    "licenses & certifications": "certifications",
    "languages": "languages",
    "achievements": "achievements",
    "awards": "achievements",
    "selected achievements": "achievements",
    "projects": "projects",
    "publications": "projects",
}

STOPWORDS = {
    "the", "and", "for", "with", "you", "your", "our", "are", "will", "that", "this",
    "from", "have", "has", "had", "not", "but", "all", "can", "any", "who", "how",
    "what", "when", "where", "why", "into", "over", "under", "about", "across",
    "through", "within", "without", "their", "they", "them", "its", "it's", "as",
    "at", "by", "be", "is", "of", "on", "or", "to", "in", "a", "an", "we", "us",
    "role", "job", "work", "team", "teams", "company", "position", "candidate",
    "experience", "years", "year", "strong", "ability", "skills", "including",
    "required", "requirements", "preferred", "plus", "must", "should", "would",
    "will", "well", "more", "most", "other", "such", "using", "use", "new",
    "including", "include", "includes", "ensure", "ensuring", "support", "help",
    "develop", "developing", "manage", "managing", "build", "building", "lead",
    "leading", "drive", "driving", "create", "creating", "deliver", "delivering",
    "nice", "hiring", "hire", "responsibilities", "responsibility", "qualifications",
    "preferred", "benefits", "salary", "apply", "applicants", "opportunity",
    "looking", "seeking",
}

# Words that should not end a keyword phrase harvested from a posting.
_PHRASE_TAIL_STOP = {
    "a", "an", "the", "and", "or", "of", "to", "for", "with", "in", "on", "at",
    "by", "as", "from", "into", "over", "under", "company", "companies",
}


def _section_name(line: str) -> str | None:
    cleaned = re.sub(r"[^a-zA-Z& ]", "", line).strip().lower()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if cleaned in SECTION_MAP:
        return SECTION_MAP[cleaned]
    # Headings such as "PROFESSIONAL EXPERIENCE" or "Experience:"
    for key, value in SECTION_MAP.items():
        if cleaned == key:
            return value
    return None


def _split_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {"header": []}
    current = "header"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            sections.setdefault(current, []).append("")
            continue
        name = _section_name(line)
        if name:
            current = name
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return sections


def _clean_lines(lines: list[str]) -> list[str]:
    return [line for line in lines if line.strip()]


def _split_skills(lines: list[str]) -> list[str]:
    found: list[str] = []
    for line in lines:
        line = re.sub(r"^[•\-*▪◦]\s*", "", line.strip())
        if not line:
            continue
        for part in re.split(r"\s*[|,;•]\s*", line):
            part = part.strip(" .")
            if 1 < len(part) <= 60:
                found.append(part)
    seen: set[str] = set()
    out = []
    for skill in found:
        key = skill.lower()
        if key not in seen:
            seen.add(key)
            out.append(skill)
    return out[:60]


def _looks_like_title(text: str) -> bool:
    low = text.lower()
    return any(re.search(rf"\b{re.escape(word)}\b", low) for word in TITLE_WORDS)


def _looks_like_company(text: str) -> bool:
    low = text.lower()
    return any(re.search(rf"\b{re.escape(word)}\b", low) for word in COMPANY_WORDS)


def _split_header(parts: list[str]) -> tuple[str, str, str]:
    """Return (company, title, location) from header fragments.

    CVs order these differently. We use title/company vocabulary to decide,
    defaulting to the common company-first order only when the text is
    ambiguous.
    """
    parts = [re.sub(r"\s+", " ", p).strip(" |,-–—") for p in parts]
    parts = [p for p in parts if p]
    if not parts:
        return "", "", ""

    if len(parts) == 1:
        text = parts[0]
        at_split = re.split(r"\s+at\s+", text, maxsplit=1, flags=re.I)
        if len(at_split) == 2:
            return at_split[1].strip(), at_split[0].strip(), ""
        for sep in (" | ", " — ", " – "):
            if sep in text:
                parts = [p.strip() for p in text.split(sep) if p.strip()]
                break
        if len(parts) == 1:
            return text, "", ""

    a, b = parts[0], parts[1]
    a_title, b_title = _looks_like_title(a), _looks_like_title(b)
    a_company, b_company = _looks_like_company(a), _looks_like_company(b)
    if a_title and not b_title:
        title, company = a, b
    elif b_title and not a_title:
        company, title = a, b
    elif a_company and not b_company:
        company, title = a, b
    elif b_company and not a_company:
        title, company = a, b
    else:
        company, title = a, b
    location = parts[2] if len(parts) > 2 else ""
    return company, title, location


def _split_experience_blocks(lines: list[str]) -> list[list[str]]:
    blocks: list[list[str]] = []
    current: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            if current:
                blocks.append(current)
                current = []
            continue
        is_date_line = bool(_YEAR_RANGE_RE.search(line)) and len(line) < 180
        if is_date_line and any(_YEAR_RANGE_RE.search(existing) for existing in current):
            blocks.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append(current)
    return blocks


def _parse_experience(lines: list[str]) -> list[ExperienceItem]:
    entries: list[ExperienceItem] = []
    for block in _split_experience_blocks(lines):
        date_idx = None
        match = None
        for idx, line in enumerate(block):
            candidate = _YEAR_RANGE_RE.search(line)
            if candidate and len(line) < 180:
                date_idx = idx
                match = candidate
                break
        if date_idx is None or match is None:
            continue

        date_line = block[date_idx]
        prefix = date_line[: match.start()].strip(" |,-–—")
        suffix = date_line[match.end() :].strip(" |,-–—")
        header_parts: list[str] = []
        for line in block[:date_idx] + ([prefix] if prefix else []):
            if line.startswith(("•", "-", "*")):
                continue
            if "|" in line:
                header_parts.extend(p.strip() for p in line.split("|") if p.strip())
            else:
                header_parts.append(line.strip())

        body = ([suffix] if suffix else []) + block[date_idx + 1 :]
        bullets = [
            re.sub(r"^[•\-*▪◦]\s*", "", line).strip()
            for line in body
            if line.strip()
        ]
        company, title, location = _split_header(header_parts)
        if not location and suffix and not re.search(r"(19|20)\d{2}", suffix):
            location = suffix

        # Some PDF exports put descriptive lines before the date line.
        if not bullets and header_parts:
            bullets = [
                re.sub(r"^[•\-*▪◦]\s*", "", x).strip()
                for x in header_parts[2:]
                if len(x) > 20
            ]

        title = _YEAR_RANGE_RE.sub("", title).strip(" -–—|,")
        company = _YEAR_RANGE_RE.sub("", company).strip(" -–—|,")
        if not company and not title and not bullets:
            continue
        entries.append(
            ExperienceItem(
                company=company,
                title=title,
                location=location,
                start=match.group(1).strip(),
                end=match.group(2).strip(),
                bullets=bullets[:12],
            )
        )
    return entries


def _parse_education(lines: list[str]) -> list[EducationItem]:
    items: list[EducationItem] = []
    for line in _clean_lines(lines):
        year = re.search(r"(19|20)\d{2}", line)
        parts = re.split(r"\s*[|–—]\s*", line)
        institution = parts[0].strip() if parts else line
        degree = parts[1].strip() if len(parts) > 1 else ""
        items.append(
            EducationItem(
                institution=institution,
                degree=degree,
                year=year.group(0) if year else "",
                details=line if len(parts) == 1 else "",
            )
        )
    return items[:10]


def parse_cv_heuristic(text: str, fallback_name: str = "") -> ParsedCV:
    text = clean_text(text)
    sections = _split_sections(text)
    header = _clean_lines(sections.get("header", []))

    email = ""
    phone = ""
    linkedin = ""
    email_match = _EMAIL_RE.search(text)
    if email_match:
        email = email_match.group(0)
    phone_match = _PHONE_RE.search(text)
    if phone_match:
        phone = phone_match.group(0).strip()
    linkedin_match = _LINKEDIN_RE.search(text)
    if linkedin_match:
        linkedin = linkedin_match.group(0).rstrip(".,")

    name = ""
    headline = ""
    for line in header:
        if _EMAIL_RE.search(line) or _PHONE_RE.search(line) or _LINKEDIN_RE.search(line):
            continue
        if len(line) > 80:
            continue
        if not name and not re.search(r"\d", line):
            name = line.strip(" |")
            continue
        if name and not headline and len(line) < 120:
            headline = line.strip(" |")
            break
    if not name:
        first = next((line for line in text.splitlines() if line.strip()), "")
        name = first[:80]
    if not name and fallback_name:
        name = fallback_name

    experience = _parse_experience(sections.get("experience", []))
    education = _parse_education(sections.get("education", []))
    skills = _split_skills(sections.get("skills", []))
    certifications = [
        re.sub(r"^[•\-*▪◦]\s*", "", line).strip()
        for line in _clean_lines(sections.get("certifications", []))
        if len(line) < 200
    ]
    languages = _split_skills(sections.get("languages", []))
    achievements = [
        re.sub(r"^[•\-*▪◦]\s*", "", line).strip()
        for line in _clean_lines(sections.get("achievements", []))
    ]
    summary = " ".join(_clean_lines(sections.get("summary", []))).strip()
    if not summary:
        # If there were no section headings, keep a short factual excerpt.
        plain = " ".join(header[:8])
        summary = plain[:800]

    return ParsedCV(
        name=name,
        headline=headline,
        contact=ContactInfo(
            email=email, phone=phone, linkedin=linkedin
        ),
        summary=summary,
        experience=experience,
        education=education,
        skills=skills,
        certifications=certifications,
        languages=languages,
        achievements=achievements,
    )


def _tokens(text: str) -> list[str]:
    raw = re.findall(r"[a-zA-ZÀ-ÿ0-9][a-zA-ZÀ-ÿ0-9+#./'-]{1,}", text.lower())
    cleaned = [token.strip(".,;:()[]{}") for token in raw]
    return [
        token
        for token in cleaned
        if len(token) > 2
        and token not in STOPWORDS
        and any(ch.isalpha() for ch in token)
    ]


_SYNONYMS = {
    "leadership": "lead", "leading": "lead", "leads": "lead", "leader": "lead",
    "scaling": "scale", "scaled": "scale", "scales": "scale",
    "engineering": "engineer", "engineers": "engineer",
    "customers": "customer", "platforms": "platform", "teams": "team",
    "technologies": "technology", "solutions": "solution",
    "strategies": "strategy", "operations": "operation",
    "organizations": "organization", "management": "manage",
    "managing": "manage", "managed": "manage",
    "development": "develop", "developing": "develop", "developed": "develop",
    "building": "build", "built": "build", "delivering": "deliver",
    "delivered": "deliver", "driving": "drive", "driven": "drive",
}


def _stem(word: str) -> str:
    word = word.lower().strip(".,;:()[]{}")
    if word in _SYNONYMS:
        return _SYNONYMS[word]
    if len(word) > 5 and word.endswith("ing"):
        return word[:-3]
    if len(word) > 4 and word.endswith("ed"):
        return word[:-2]
    if len(word) > 4 and word.endswith("es"):
        return word[:-2]
    if len(word) > 4 and word.endswith("s") and not word.endswith(("ss", "is", "us")):
        return word[:-1]
    return word


def _match_tokens(text: str) -> list[str]:
    return [_stem(token) for token in _tokens(text)]


def _clean_phrase(phrase: str) -> str:
    phrase = re.sub(r"\s+", " ", phrase).strip(" .,;:-")
    words = phrase.split()
    while words and words[-1].lower() in _PHRASE_TAIL_STOP:
        words.pop()
    return " ".join(words)


def _keywords(text: str, limit: int = 40) -> list[str]:
    counts = Counter(_tokens(text))
    # Prefer multi-word domain phrases when they repeat.
    phrases = Counter(
        _clean_phrase(m.group(0).lower())
        for m in re.finditer(
            r"\b(?:AI|ML|LLM|SaaS|B2B|B2C|P&L|go-to-market|product-led|data|cloud|security|fintech|healthtech|enterprise)\b"
            r"(?:\s+[a-z]{3,}){0,2}",
            text,
            re.I,
        )
    )
    ranked = [word for word, _ in counts.most_common(limit)]
    for phrase, _ in phrases.most_common(12):
        if phrase and len(phrase) > 2 and phrase not in ranked:
            ranked.append(phrase)
    return ranked[:limit]


def _extract_requirements(text: str) -> tuple[list[str], list[str], list[str]]:
    must, nice, responsibilities = [], [], []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", line):
            item = re.sub(r"^[•\-*▪◦\d.)]+\s*", "", sentence).strip()
            if len(item) < 10 or item in seen:
                continue
            seen.add(item)
            low = item.lower()
            if any(word in low for word in ("must have", "must-have", "required", "requirements", "minimum of", "at least", "you have", "proven", "demonstrated")):
                must.append(item)
            elif any(word in low for word in ("nice to have", "nice-to-have", "preferred", "a plus", "bonus")):
                nice.append(item)
            elif any(word in low for word in ("responsib", "you will", "own ", "lead ", "drive ", "build ", "manage ", "develop ", "deliver ", "partner ")):
                responsibilities.append(item)
    return must[:15], nice[:10], responsibilities[:15]


def _overlap(requirement: str, candidate_lower: str) -> float:
    words = [w for w in _match_tokens(requirement) if len(w) > 3]
    if not words:
        return 0.0
    hit = sum(1 for word in words if word in candidate_lower)
    return hit / len(words)


def _best_evidence(requirement: str, candidate_lines: list[str]) -> str:
    words = {w for w in _match_tokens(requirement) if len(w) > 3}
    best_idx, best_score = -1, 0
    for idx, line in enumerate(candidate_lines):
        if len(line) < 20:
            continue
        low = " ".join(_match_tokens(line))
        score = sum(1 for word in words if word in low)
        if score > best_score:
            best_idx, best_score = idx, score
    if best_idx < 0:
        return ""

    # PDF/DOCX exports wrap bullets across lines. Join the continuation so the
    # evidence reads as a complete thought instead of stopping mid-sentence.
    parts = [re.sub(r"^[•\-*▪◦]\s*", "", candidate_lines[best_idx].strip())]
    cursor = best_idx
    while (
        parts
        and len(" ".join(parts)) < 360
        and not re.search(r"[.!?;:]$", parts[-1])
        and cursor + 1 < len(candidate_lines)
    ):
        following = candidate_lines[cursor + 1].strip()
        if re.match(r"^[•\-*▪◦]", following) or _section_name(following):
            break
        parts.append(following)
        cursor += 1
    return " ".join(parts)[:400]


def detect_language(text: str) -> str:
    if re.search(r"[\u0590-\u05FF]", text):
        return "he"
    if re.search(r"[\u0600-\u06FF]", text):
        return "ar"
    if re.search(r"[\u0400-\u04FF]", text):
        return "ru"
    if re.search(r"[\u4E00-\u9FFF]", text):
        return "zh"
    return "en"


def analyze_job_heuristic(
    job_description: str,
    candidate_text: str,
    cvs: list[dict] | None = None,
    fallback_title: str = "",
    fallback_company: str = "",
) -> JobAnalysis:
    jd = clean_text(job_description)
    language = detect_language(jd)
    lines = [line.strip() for line in jd.splitlines() if line.strip()]
    title = fallback_title
    company = fallback_company
    for line in lines:
        low = line.lower()
        if not title and any(prefix in low for prefix in ("job title", "position", "role:", "title:")):
            title = re.split(r":", line, maxsplit=1)[-1].strip()
        if not company and any(prefix in low for prefix in ("company:", "organization:", "employer:")):
            company = re.split(r":", line, maxsplit=1)[-1].strip()
    if not title and lines:
        title = lines[0][:120]

    must, nice, responsibilities = _extract_requirements(jd)
    keywords = _keywords(jd, 45)
    candidate_lower = candidate_text.lower()
    candidate_stemmed = " ".join(_match_tokens(candidate_text))
    candidate_lines = [line.strip() for line in candidate_text.splitlines() if line.strip()]

    strengths: list[Evidence] = []
    gaps: list[Gap] = []
    for idx, requirement in enumerate(must):
        score = _overlap(requirement, candidate_stemmed)
        if score >= 0.34:
            strengths.append(
                Evidence(
                    requirement=requirement,
                    evidence=_best_evidence(requirement, candidate_lines),
                    source="source CV",
                )
            )
        else:
            gaps.append(
                Gap(
                    requirement=requirement,
                    severity="high" if idx < 5 else "medium",
                    mitigation="Do not claim this. Address adjacent, evidence-backed experience only.",
                )
            )

    coverage = len(strengths) / max(1, len(must))
    keyword_hits = sum(1 for kw in keywords if kw in candidate_lower)
    keyword_coverage = keyword_hits / max(1, len(keywords))
    score = int(round(100 * (0.65 * coverage + 0.35 * keyword_coverage)))
    score = max(0, min(100, score))
    level = "strong" if score >= 75 else "moderate" if score >= 50 else "weak"

    supported = [kw for kw in keywords if kw in candidate_lower][:30]
    recommended_cv_id = None
    recommended_vertical = ""
    if cvs:
        best_score = -1
        for cv in cvs:
            cv_text = (cv.get("raw_text") or "").lower()
            cv_score = sum(1 for kw in keywords if kw in cv_text)
            if cv_score > best_score:
                best_score = cv_score
                recommended_cv_id = cv.get("id")
                recommended_vertical = cv.get("vertical", "")

    plan = [
        "Lead with the achievements that prove the must-have requirements.",
        "Mirror the posting's exact terminology only where the source CV supports it.",
        "Keep company names, titles, dates, and metrics unchanged.",
        "Use a single-column, ATS-safe layout with standard section headings.",
    ]
    if supported:
        plan.append("Emphasise supported keywords: " + ", ".join(supported[:12]) + ".")
    if gaps:
        plan.append("Do not claim: " + "; ".join(g.requirement for g in gaps[:4]) + ".")

    return JobAnalysis(
        job_title=title,
        company=company,
        location="",
        seniority="executive" if any(w in jd.lower() for w in ("chief", "vp", "vice president", "head of", "director")) else "",
        language=language,
        summary=(
            f"Offline heuristic review: {score}/100 match. "
            f"{len(strengths)} of {len(must)} explicit requirements have direct evidence."
        ),
        must_have=must,
        nice_to_have=nice,
        responsibilities=responsibilities,
        ats_keywords=keywords,
        culture_signals=[],
        red_flags=[],
        match_score=score,
        match_level=level,
        strengths=strengths,
        gaps=gaps,
        recommended_cv_id=recommended_cv_id,
        recommended_vertical=recommended_vertical,
        tailoring_plan=plan,
        keywords_to_include=supported,
        do_not_claim=[g.requirement for g in gaps],
        analyzer_notes="Generated by the deterministic offline analyser (no LLM configured).",
    )


def _build_competencies(
    supported: list[str],
    skills: list[str],
    job_terms: set[str],
    limit: int = 12,
) -> list[str]:
    """Build a compact competency list from supported terms and relevant skills.

    Phrases come first because "Cloud Cost Optimization" reads better than
    "Cloud" and "Cost" as separate items. Single words already covered by a
    phrase are skipped, as are generic verbs harvested from the posting.
    """
    weak = {
        "head", "own", "looking", "seeking", "organisation", "organization",
        "scale", "scaling", "nice", "hiring", "responsibilities", "high-performing",
        "cost",
    }
    chosen: list[str] = []

    def word_set(text: str) -> set[str]:
        return {_stem(word) for word in text.lower().split()}

    def add(item: str) -> None:
        item = re.sub(r"\s+", " ", item).strip(" .,;:-")
        if len(item) < 2 or item.lower() in weak:
            return
        words = word_set(item)
        for existing in chosen:
            if words <= word_set(existing):
                return
        chosen.append(item)

    for keyword in supported:
        if " " in keyword:
            add(keyword)
    for keyword in supported:
        if " " not in keyword:
            add(keyword)
    for skill in skills:
        low = skill.lower()
        if low in job_terms or any(word in job_terms for word in low.split()):
            add(skill)
    return chosen[:limit]


def tailor_heuristic(
    parsed: ParsedCV,
    analysis: JobAnalysis,
    source_text: str,
    context: str,
    language: str | None = None,
) -> TailoredCV:
    source_lower = (source_text + "\n" + context).lower()
    supported = [kw for kw in analysis.keywords_to_include if kw.lower() in source_lower]
    if not supported:
        supported = [kw for kw in analysis.ats_keywords if kw.lower() in source_lower][:15]

    summary = parsed.summary.strip()
    if not summary:
        summary = clean_text(context)[:800]
    if not summary:
        summary = "Experienced professional. See detailed experience below."

    experience: list[ExperienceItem] = []
    for entry in parsed.experience:
        scored = []
        for idx, bullet in enumerate(entry.bullets):
            low = bullet.lower()
            score = sum(1 for kw in supported if kw.lower() in low)
            scored.append((score, idx, bullet))
        scored.sort(key=lambda item: (-item[0], item[1]))
        selected = [bullet for _, _, bullet in scored[:8]]
        # Preserve original order among selected bullets.
        order = {bullet: idx for idx, bullet in enumerate(entry.bullets)}
        selected.sort(key=lambda bullet: order.get(bullet, 0))
        experience.append(entry.model_copy(update={"bullets": selected}))

    competencies = _build_competencies(
        supported,
        parsed.skills,
        {kw.lower() for kw in analysis.ats_keywords},
    ) or parsed.skills[:12]
    grounding = [
        Evidence(
            requirement=item.requirement,
            evidence=item.evidence,
            source=item.source or "source CV",
        )
        for item in analysis.strengths[:12]
    ]

    return TailoredCV(
        language=language or analysis.language or "en",
        name=parsed.name,
        headline=parsed.headline,
        contact=parsed.contact,
        summary=summary,
        core_competencies=competencies,
        experience=experience,
        education=parsed.education,
        certifications=parsed.certifications,
        skills=parsed.skills,
        languages=parsed.languages,
        ats_keywords=supported,
        change_log=[
            "Selected and reordered existing achievements by relevance to the posting.",
            "Kept every employer, title, date, and metric from the source CV unchanged.",
            "No unsupported requirements were added.",
        ],
        grounding=grounding,
    )


def candidate_digest(context: str, cvs: list[dict], max_chars: int = 60000) -> str:
    """Build the evidence corpus handed to the headhunter."""
    parts = ["## CANDIDATE CONTEXT\n" + clean_text(context)]
    for cv in cvs:
        parts.append(
            f"\n## CV VERSION {cv.get('id')} — VERTICAL: {cv.get('vertical', '')}\n"
            + clean_text(cv.get("raw_text") or "")
        )
    digest = "\n".join(parts)
    if len(digest) > max_chars:
        digest = digest[:max_chars] + "\n… [truncated to fit the model context]"
    return digest
