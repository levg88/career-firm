#!/usr/bin/env python3
"""UserPromptSubmit hook: match the user prompt against Context/ContextMapping.md
topics + aliases and inject the resolved Memory.md paths as context.
Keeps aliases in ONE place (ContextMapping.md) - new topics are covered automatically."""
import json
import re
import sys

MAX_TOPICS = 6
# Aliases too generic to trigger on their own (they match only inside a longer phrase).
NOISE = {"agents", "cli", "providers", "settings", "tests"}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    prompt = (data.get("prompt") or "").strip()
    if len(prompt) < 4:
        return

    try:
        with open("Context/ContextMapping.md", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return

    matches = []
    in_topic_table = False
    for line in lines:
        if line.startswith("## "):
            in_topic_table = line.startswith("## Topic table")
            continue
        if not in_topic_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] in ("Topic", ":---", "---") or cells[0].startswith("-"):
            continue
        topic, aliases, path = cells[0], cells[1], cells[2].strip("`")
        terms = [topic] + [a.strip() for a in aliases.split(",") if a.strip()]
        for term in terms:
            if term.lower() in NOISE:
                continue
            # Every word of the term must appear in the prompt (any order, any
            # distance), allowing a trailing plural 's' or digits - so
            # "released versions" matches "list all released project versions".
            words = term.split()
            if all(
                re.search(
                    r"\b"
                    + re.escape(w[:-1] if len(w) > 3 and w.endswith("s") else w)
                    + r"(s|\d+)?\b",
                    prompt,
                    re.IGNORECASE,
                )
                for w in words
            ):
                matches.append((topic, path))
                break

    if not matches:
        return
    listing = "; ".join(f"{t} -> {p}" for t, p in matches[:MAX_TOPICS])
    ctx = (
        "[Context Router] Domain topics matched in Context/ContextMapping.md: "
        + listing
        + ". GATE: read these Memory.md files (and any mirror file they point to) "
        "BEFORE grepping code or searching external sources. "
        "New domain findings go to Context/_inbox/ tagged (provider / OS, date) or (General)."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": ctx,
        }
    }))


if __name__ == "__main__":
    main()
