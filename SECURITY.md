# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Career Firm, please report it privately
by emailing the project maintainers rather than opening a public issue.

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest on `main` | ✅ |
| Older versions | ❌ |

## Security considerations

- Career Firm binds to `127.0.0.1` by default. Do not expose it to untrusted networks.
- API keys are stored only in the local SQLite database (`data/firm.db`, mode `0600`).
- No telemetry or analytics are collected.
- Provider keys are sent only to the configured provider endpoint.
- Generated files and uploads are stored locally under `data/`.
- Do not commit `.env` files or database files to version control.
