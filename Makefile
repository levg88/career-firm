.PHONY: install test serve init doctor

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	.venv/bin/pytest -q

init:
	.venv/bin/career-firm init

doctor:
	.venv/bin/career-firm doctor

serve:
	.venv/bin/career-firm serve
