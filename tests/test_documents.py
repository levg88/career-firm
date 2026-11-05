from __future__ import annotations

from pathlib import Path

from docx import Document
from pypdf import PdfReader

from career_firm.documents.extract import extract_text
from career_firm.documents.heuristics import parse_cv_heuristic, tailor_heuristic, analyze_job_heuristic
from career_firm.documents.render import page_count, render_cv


def _tailored(sample_cv, sample_jd):
    parsed = parse_cv_heuristic(sample_cv)
    analysis = analyze_job_heuristic(sample_jd, sample_cv)
    return tailor_heuristic(parsed, analysis, sample_cv, "Executive leader.")


def test_extract_docx(tmp_path: Path):
    path = tmp_path / "cv.docx"
    doc = Document()
    doc.add_paragraph("Jane Doe")
    doc.add_paragraph("SUMMARY")
    doc.add_paragraph("Engineering executive.")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Acme Corp"
    table.cell(0, 1).text = "2020 - Present"
    doc.save(path)
    text = extract_text(path)
    assert "Jane Doe" in text
    assert "Acme Corp" in text
    assert "2020 - Present" in text


def test_extract_markdown(tmp_path: Path):
    path = tmp_path / "cv.md"
    path.write_text("# Jane Doe\n\nEXPERIENCE\nAcme Corp 2020 - Present", encoding="utf-8")
    assert "Acme Corp" in extract_text(path)


def test_render_pdf_and_docx(tmp_path: Path, sample_cv, sample_jd):
    cv = _tailored(sample_cv, sample_jd)
    result = render_cv(cv, tmp_path, "jane_doe")
    pdf = Path(result["pdf_path"])
    docx = Path(result["docx_path"])
    assert pdf.is_file() and pdf.stat().st_size > 1000
    assert docx.is_file() and docx.stat().st_size > 1000
    assert page_count(pdf) <= 2

    pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(str(pdf)).pages)
    assert "Jane Doe" in pdf_text
    assert "Acme Corp" in pdf_text
    assert "45" in pdf_text
    assert "CORE COMPETENCIES" in pdf_text

    doc_text = "\n".join(p.text for p in Document(str(docx)).paragraphs)
    assert "Jane Doe" in doc_text
    assert "Acme Corp" in doc_text
    assert "45" in doc_text
    # ATS-safe: no tables, no headers/footers.
    assert len(Document(str(docx)).tables) == 0
