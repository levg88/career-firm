from __future__ import annotations

import re

from ..models import JobAnalysis, TailoredCV


def _norm(text: str) -> str:
    text = (text or "").lower()
    text = text.replace("–", "-").replace("—", "-").replace("’", "'")
    text = re.sub(r"[^a-z0-9\u0590-\u05ff\u0600-\u06ff\u0400-\u04ff\u4e00-\u9fff]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _numbers(text: str) -> set[str]:
    cleaned = (text or "").replace(",", "")
    return {n for n in re.findall(r"\d+(?:\.\d+)?", cleaned)}


def _company_supported(company: str, corpus_norm: str) -> bool:
    company_norm = _norm(company)
    if not company_norm:
        return True
    if company_norm in corpus_norm:
        return True
    tokens = [token for token in company_norm.split() if len(token) > 2]
    if not tokens:
        return True
    hits = sum(1 for token in tokens if token in corpus_norm)
    return hits / len(tokens) >= 0.75


def validate_grounding(
    cv: TailoredCV,
    source_text: str,
    context: str,
    analysis: JobAnalysis,
) -> list[str]:
    """Flag plausible-but-unsupported claims. Deterministic, conservative.

    This is a safety net, not a truth oracle: it catches new employers, years,
    metrics, and contact details that do not appear anywhere in the source.
    """
    corpus = source_text + "\n" + context
    corpus_norm = _norm(corpus)
    corpus_numbers = _numbers(corpus)
    warnings: list[str] = []

    if not cv.experience:
        warnings.append("No experience entries were produced; review the source CV before sending.")

    for item in cv.experience:
        if item.company and not _company_supported(item.company, corpus_norm):
            warnings.append(
                f"Unverified employer '{item.company}'. It does not appear in the source CV/context."
            )
        for year in re.findall(r"(?:19|20)\d{2}", f"{item.start} {item.end}"):
            if year not in corpus_numbers:
                warnings.append(f"Unverified date '{year}' in {item.company or 'an experience entry'}.")
        for bullet in item.bullets:
            for number in _numbers(bullet):
                if number not in corpus_numbers:
                    warnings.append(
                        f"Unverified metric '{number}' in a bullet for {item.company or 'an experience entry'}: "
                        f"{bullet[:140]}"
                    )

    if cv.contact.email and _norm(cv.contact.email) not in corpus_norm:
        warnings.append(f"Email '{cv.contact.email}' does not appear in the source profile.")
    if cv.contact.phone:
        digits = re.sub(r"\D", "", cv.contact.phone)
        if digits and digits not in re.sub(r"\D", "", corpus):
            warnings.append(f"Phone '{cv.contact.phone}' does not appear in the source profile.")

    generated_text = " ".join(
        [cv.summary, cv.headline]
        + cv.core_competencies
        + cv.skills
        + [bullet for item in cv.experience for bullet in item.bullets]
    )
    generated_norm = _norm(generated_text)
    for claim in analysis.do_not_claim:
        claim_norm = _norm(claim)
        if len(claim_norm) >= 12 and claim_norm in generated_norm:
            warnings.append(f"Generated text appears to claim a stated gap: {claim[:160]}")

    unsupported_keywords = [
        keyword
        for keyword in cv.ats_keywords
        if keyword and _norm(keyword) not in corpus_norm
    ]
    if unsupported_keywords:
        warnings.append(
            "ATS keywords not found in the source were removed: "
            + ", ".join(unsupported_keywords[:15])
        )

    # De-duplicate while preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for warning in warnings:
        if warning not in seen:
            seen.add(warning)
            unique.append(warning)
    return unique[:40]


def remove_unsupported_keywords(cv: TailoredCV, source_text: str, context: str) -> TailoredCV:
    corpus_norm = _norm(source_text + "\n" + context)
    supported = [kw for kw in cv.ats_keywords if kw and _norm(kw) in corpus_norm]
    if len(supported) == len(cv.ats_keywords):
        return cv
    return cv.model_copy(update={"ats_keywords": supported})
