from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterable

from ..models import TailoredCV
from .extract import clean_text

RTL_LANGUAGES = {"he", "ar", "fa", "ur"}


def _plain(text: str) -> str:
    text = str(text or "")
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text)
    text = text.replace("\u00a0", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def _safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return value or "cv"


def _contact_line(cv: TailoredCV) -> str:
    contact = cv.contact
    parts = [
        contact.location,
        contact.email,
        contact.phone,
        contact.linkedin,
        contact.website,
    ]
    return " | ".join(_plain(part) for part in parts if _plain(part))


_ACRONYMS = {
    "ai": "AI", "ml": "ML", "llm": "LLM", "llms": "LLMs", "saas": "SaaS",
    "b2b": "B2B", "b2c": "B2C", "p&l": "P&L", "vp": "VP", "svp": "SVP",
    "evp": "EVP", "cto": "CTO", "ceo": "CEO", "cfo": "CFO", "coo": "COO",
    "cio": "CIO", "cro": "CRO", "cmo": "CMO", "aws": "AWS", "gcp": "GCP",
    "sql": "SQL", "api": "API", "apis": "APIs", "etl": "ETL", "devops": "DevOps",
    "kubernetes": "Kubernetes", "python": "Python", "java": "Java",
}


def _display_term(term: str) -> str:
    words = _plain(term).split()
    out = []
    for word in words:
        lower = word.lower()
        if lower in _ACRONYMS:
            out.append(_ACRONYMS[lower])
        elif word.islower():
            out.append(word[:1].upper() + word[1:])
        else:
            out.append(word)
    return " ".join(out)


def _experience_heading(item) -> str:
    left = " — ".join(x for x in (_plain(item.company), _plain(item.title)) if x)
    dates = " – ".join(x for x in (_plain(item.start), _plain(item.end)) if x)
    bits = [left] if left else []
    if dates:
        bits.append(dates)
    return " | ".join(bits)


def _section_rows(cv: TailoredCV) -> Iterable[tuple[str, str, list[str]]]:
    """Yield (kind, text, items) in the canonical ATS-friendly order."""
    if cv.summary.strip():
        yield "para", _plain(cv.summary), []
    if cv.core_competencies:
        yield "inline", "CORE COMPETENCIES", [_display_term(x) for x in cv.core_competencies if _plain(x)]
    if cv.experience:
        yield "section", "PROFESSIONAL EXPERIENCE", []
        for item in cv.experience:
            yield "experience", "", [item]  # type: ignore[list-item]
    if cv.education:
        yield "section", "EDUCATION", []
        for item in cv.education:
            yield "education", "", [item]  # type: ignore[list-item]
    if cv.certifications:
        yield "bullets", "CERTIFICATIONS", [_plain(x) for x in cv.certifications if _plain(x)]
    if cv.skills:
        yield "inline", "SKILLS", [_display_term(x) for x in cv.skills if _plain(x)]
    if cv.languages:
        yield "inline", "LANGUAGES", [_display_term(x) for x in cv.languages if _plain(x)]


# ── DOCX ─────────────────────────────────────────────────────────────────────

def _docx_font() -> str:
    return "Calibri"


def render_docx(cv: TailoredCV, path: Path, scale: float = 1.0) -> Path:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor

    path.parent.mkdir(parents=True, exist_ok=True)
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Inches(0.55)
    section.bottom_margin = Inches(0.5)
    section.left_margin = Inches(0.65)
    section.right_margin = Inches(0.65)

    normal = doc.styles["Normal"]
    normal.font.name = _docx_font()
    normal.font.size = Pt(10.2 * scale)
    normal.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.line_spacing = 1.03

    def paragraph(
        text: str = "",
        *,
        size: float | None = None,
        bold: bool = False,
        italic: bool = False,
        color: tuple[int, int, int] | None = None,
        space_before: float = 0,
        space_after: float = 0,
        align=None,
        indent: float = 0,
    ):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(space_before)
        p.paragraph_format.space_after = Pt(space_after)
        if align is not None:
            p.alignment = align
        if indent:
            p.paragraph_format.left_indent = Inches(indent)
            p.paragraph_format.first_line_indent = Inches(-indent)
        if text:
            run = p.add_run(text)
            run.bold = bold
            run.italic = italic
            if size:
                run.font.size = Pt(size)
            if color:
                run.font.color.rgb = RGBColor(*color)
        return p

    def heading(text: str) -> None:
        p = paragraph(
            text.upper(),
            size=10.2 * scale,
            bold=True,
            space_before=6.5 * scale,
            space_after=1.5 * scale,
            color=(0x22, 0x22, 0x22),
        )
        pPr = p._p.get_or_add_pPr()
        borders = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "4")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), "AAAAAA")
        borders.append(bottom)
        pPr.append(borders)

    def bullet(text: str) -> None:
        paragraph("• " + _plain(text), size=9.9 * scale, indent=0.17, space_after=0.6 * scale)

    # Header
    paragraph(
        _plain(cv.name) or "Candidate",
        size=19 * scale,
        bold=True,
        space_after=1,
        color=(0x11, 0x11, 0x11),
    )
    if cv.headline:
        paragraph(_plain(cv.headline), size=10.8 * scale, italic=True, space_after=1.5, color=(0x33, 0x33, 0x33))
    contact = _contact_line(cv)
    if contact:
        paragraph(contact, size=9.0 * scale, space_after=2, color=(0x44, 0x44, 0x44))

    for kind, text, items in _section_rows(cv):
        if kind == "para":
            heading("PROFESSIONAL SUMMARY")
            paragraph(text, size=9.9 * scale, space_after=1)
        elif kind == "inline":
            heading(text)
            paragraph(", ".join(items), size=9.6 * scale, space_after=1)
        elif kind == "bullets":
            heading(text)
            for item in items:
                bullet(item)
        elif kind == "section":
            heading(text)
        elif kind == "experience":
            item = items[0]
            p = paragraph(space_after=0.5)
            run = p.add_run(_experience_heading(item))
            run.bold = True
            run.font.size = Pt(10.0 * scale)
            if item.location or item.context:
                sub = " | ".join(x for x in (_plain(item.location), _plain(item.context)) if x)
                if sub:
                    paragraph(sub, size=8.9 * scale, italic=True, space_after=1, color=(0x55, 0x55, 0x55))
            for line in item.bullets:
                bullet(line)
        elif kind == "education":
            item = items[0]
            left = " — ".join(x for x in (_plain(item.institution), _plain(item.degree)) if x)
            bits = [left] if left else []
            if item.location:
                bits.append(_plain(item.location))
            if item.year:
                bits.append(_plain(item.year))
            paragraph(" | ".join(bits), size=9.8 * scale, bold=bool(left), space_after=0.5)
            if item.details:
                paragraph(_plain(item.details), size=9.2 * scale, space_after=0.5)

    doc.save(str(path))
    return path


def _first_experience(cv: TailoredCV) -> bool:
    return bool(cv.experience)


def _first_education(cv: TailoredCV) -> bool:
    return bool(cv.education)


# ── PDF ──────────────────────────────────────────────────────────────────────

def _font_candidates(font_path: str | None = None) -> dict[str, str]:
    """Find a TrueType family for Unicode output, with platform fallbacks."""
    candidates: list[dict[str, str]] = []
    if font_path:
        p = Path(font_path)
        if p.is_file():
            candidates.append({"": str(p), "B": str(p), "I": str(p), "BI": str(p)})

    if sys.platform == "darwin":
        base = Path("/System/Library/Fonts/Supplemental")
        candidates.append(
            {
                "": str(base / "Arial.ttf"),
                "B": str(base / "Arial Bold.ttf"),
                "I": str(base / "Arial Italic.ttf"),
                "BI": str(base / "Arial Bold Italic.ttf"),
            }
        )
    elif sys.platform.startswith("win"):
        base = Path("C:/Windows/Fonts")
        candidates.append(
            {
                "": str(base / "arial.ttf"),
                "B": str(base / "arialbd.ttf"),
                "I": str(base / "ariali.ttf"),
                "BI": str(base / "arialbi.ttf"),
            }
        )
    candidates.append(
        {
            "": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "B": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "I": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
            "BI": "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
        }
    )
    for family in candidates:
        if family.get("") and Path(family[""]).is_file():
            return {style: path for style, path in family.items() if Path(path).is_file()}
    return {}


def _unicode_fallback() -> str | None:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).is_file():
            return candidate
    return None


def render_pdf(
    cv: TailoredCV,
    path: Path,
    scale: float = 1.0,
    font_path: str | None = None,
) -> Path:
    from fpdf import FPDF

    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = FPDF(format="Letter", unit="mm")
    pdf.set_margins(16.5, 13.5, 16.5)
    pdf.set_auto_page_break(auto=True, margin=12.5)
    pdf.add_page()

    family = "Helvetica"
    fonts = _font_candidates(font_path)
    if fonts:
        family = "CVFont"
        for style, file in fonts.items():
            pdf.add_font(family, style=style, fname=file)
        fallback = _unicode_fallback()
        if fallback:
            pdf.add_font("CVUnicode", style="", fname=fallback)
            try:
                pdf.set_fallback_fonts(["CVUnicode"])
            except Exception:
                pass
    else:
        pdf.set_font("Helvetica", size=10)

    rtl = (cv.language or "en").lower()[:2] in RTL_LANGUAGES
    align = "R" if rtl else "L"
    if rtl:
        for args, kwargs in (
            ((True,), {"direction": "rtl"}),
            ((True,), {}),
            ((), {}),
        ):
            try:
                pdf.set_text_shaping(*args, **kwargs)
                break
            except Exception:
                continue

    def set_font(style: str, size: float) -> None:
        pdf.set_font(family, style=style, size=size * scale)

    def text_block(text: str, size: float, style: str = "", height: float = 1.28, space_after: float = 0) -> None:
        set_font(style, size)
        pdf.multi_cell(
            0,
            size * height * 0.3528 * scale,
            _plain(text),
            align=align,
            new_x="LMARGIN",
            new_y="NEXT",
        )
        if space_after:
            pdf.ln(space_after * scale)

    def heading(title: str) -> None:
        pdf.ln(2.6 * scale)
        set_font("B", 9.8)
        pdf.cell(0, 4.6 * scale, title.upper(), align=align, new_x="LMARGIN", new_y="NEXT")
        y = pdf.get_y()
        pdf.set_draw_color(170, 170, 170)
        pdf.set_line_width(0.18)
        pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
        pdf.ln(0.9 * scale)

    def bullet(text: str) -> None:
        set_font("", 9.6)
        pdf.set_x(pdf.l_margin + 3.2)
        pdf.multi_cell(
            pdf.epw - 3.2,
            9.6 * 1.26 * 0.3528 * scale,
            "• " + _plain(text),
            align=align,
            new_x="LMARGIN",
            new_y="NEXT",
        )

    # Header
    pdf.set_text_color(17, 17, 17)
    text_block(_plain(cv.name) or "Candidate", 18.5, "B", space_after=0.4)
    if cv.headline:
        pdf.set_text_color(51, 51, 51)
        text_block(cv.headline, 10.4, "I", space_after=0.6)
    contact = _contact_line(cv)
    if contact:
        pdf.set_text_color(68, 68, 68)
        text_block(contact, 8.6, "", space_after=0.5)
    pdf.set_text_color(26, 26, 26)

    for kind, text, items in _section_rows(cv):
        if kind == "para":
            heading("Professional Summary")
            text_block(text, 9.6, space_after=0.6)
        elif kind == "inline":
            heading(text)
            text_block(", ".join(items), 9.2, space_after=0.6)
        elif kind == "bullets":
            heading(text)
            for item in items:
                bullet(item)
        elif kind == "section":
            heading(text)
        elif kind == "experience":
            item = items[0]
            set_font("B", 9.8)
            pdf.multi_cell(
                0,
                9.8 * 1.18 * 0.3528 * scale,
                _plain(_experience_heading(item)),
                align=align,
                new_x="LMARGIN",
                new_y="NEXT",
            )
            sub = " | ".join(x for x in (_plain(item.location), _plain(item.context)) if x)
            if sub:
                pdf.set_text_color(85, 85, 85)
                text_block(sub, 8.5, "I", space_after=0.3)
                pdf.set_text_color(26, 26, 26)
            for line in item.bullets:
                bullet(line)
        elif kind == "education":
            item = items[0]
            left = " — ".join(x for x in (_plain(item.institution), _plain(item.degree)) if x)
            bits = [left] if left else []
            if item.location:
                bits.append(_plain(item.location))
            if item.year:
                bits.append(_plain(item.year))
            set_font("B" if left else "", 9.5)
            pdf.multi_cell(0, 4.0 * scale, " | ".join(bits), align=align, new_x="LMARGIN", new_y="NEXT")
            if item.details:
                text_block(item.details, 8.7, space_after=0.3)

    pdf.output(str(path))
    return path


def page_count(path: Path) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:
        return 0


def render_cv(
    cv: TailoredCV,
    out_dir: Path,
    basename: str,
    *,
    font_path: str | None = None,
    max_pages: int = 2,
) -> dict:
    """Render matching DOCX + PDF, shrinking until the PDF fits max_pages."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(basename)
    docx_path = out_dir / f"{stem}.docx"
    pdf_path = out_dir / f"{stem}.pdf"

    chosen_scale = 1.0
    pages = 0
    for scale in (1.0, 0.95, 0.9, 0.86, 0.82):
        render_pdf(cv, pdf_path, scale=scale, font_path=font_path)
        pages = page_count(pdf_path)
        chosen_scale = scale
        if pages and pages <= max_pages:
            break

    render_docx(cv, docx_path, scale=chosen_scale)
    return {
        "docx_path": str(docx_path),
        "pdf_path": str(pdf_path),
        "pages": pages,
        "scale": chosen_scale,
    }
