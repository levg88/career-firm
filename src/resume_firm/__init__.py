"""Resume Firm — an agent-run career firm.

The package is deliberately split into three reusable layers:

* ``agents``      — role definitions and the tool-calling agent runtime
* ``orchestrator``— workflows that chain agents and persist their work
* ``documents``   — deterministic CV extraction and rendering

The dedicated "firm" agents (office manager, headhunter, resume writer) and the
general build agents (PM, architect, developer, QA) share the same runtime.
"""

__version__ = "0.1.0"
