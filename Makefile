.PHONY: install test serve init doctor

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	.venv/bin/pytest -q

init:
	.venv/bin/resume-firm init

doctor:
	.venv/bin/resume-firm doctor

serve:
	.venv/bin/resume-firm serve
