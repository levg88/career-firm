from __future__ import annotations

import re
from pathlib import Path


class ExtractionError(RuntimeError):
    pass


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError as exc:  # pragma: no cover
        raise ExtractionError("python-docx is required to read DOCX files") from exc

    document = Document(str(path))
    parts: list[str] = []
    for paragraph in document.paragraphs:
        if paragraph.text.strip():
            parts.append(paragraph.text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    for section in document.sections:
        for header in (section.header, section.footer):
            for paragraph in header.paragraphs:
                if paragraph.text.strip():
                    parts.append(paragraph.text)
    return clean_text("\n".join(parts))


def extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise ExtractionError("pypdf is required to read PDF files") from exc

    try:
        reader = PdfReader(str(path))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        raise ExtractionError(f"Could not read PDF: {exc}") from exc
    return clean_text("\n".join(pages))


def extract_text(path: Path | str) -> str:
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix in {".txt", ".md", ".markdown"}:
        try:
            return clean_text(path.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            raise ExtractionError(f"Could not read {path.name}: {exc}") from exc
    if suffix == ".doc":
        raise ExtractionError(
            "Legacy .doc files are not supported. Save the file as .docx or PDF and retry."
        )
    raise ExtractionError(
        f"Unsupported file type '{suffix or 'unknown'}'. Use DOCX, PDF, TXT, or Markdown."
    )


def excerpt(text: str, limit: int = 12000) -> str:
    text = clean_text(text)
    if len(text) <= limit:
        return text
    return text[:limit].rsplit("\n", 1)[0] + "\n… [truncated]"
