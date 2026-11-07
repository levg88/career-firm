# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Progress bar on job detail page (Analyzing → Writing → Rendering)
- Provider toggle in settings (Local Ollama / Online OpenCode / Offline)
- LinkedIn PDF export import on profile page
- CV experience preservation (no dropped employers)
- Chronology ordering fix (source CV order preserved)
- Auto-score CV via configured model
- ChatGPT scoring option (copy CV + JD, download, open ChatGPT)

### Changed
- Setup wizard now shows provider-specific fields (Ollama server URL, OpenCode API key)
- Resume writer prompt: keep EVERY employer, never drop
- normalise() matches generated experiences to source, pads missing ones

## [1.0.0] - 2026-11-05

### Added
- Initial release
- Three-agent firm: Office Manager → Headhunter → Resume Writer
- TypeScript/Express 5/SQLite web app
- CV import (DOCX, PDF, TXT, MD)
- Job tailoring with ATS optimization
- PDF + DOCX generation
- Grounding validation (truthfulness checks)
- Setup wizard with provider configuration
- 37 tests, TypeScript strict mode
