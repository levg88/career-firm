from __future__ import annotations

import pytest
from pydantic import BaseModel

from career_firm import db
from career_firm.agents.base import Agent, AgentSpec, Tool, ToolRegistry
from career_firm.agents.runner import run_agent
from career_firm.llm.base import LLMClient, LLMResponse, ToolCall, parse_json_object


class ScriptedLLM(LLMClient):
    provider = "scripted"
    model = "scripted"

    def __init__(self, responses):
        self.responses = list(responses)

    def complete(self, messages, *, tools=None, temperature=None, max_tokens=None, json_mode=False):
        return self.responses.pop(0)


class Answer(BaseModel):
    ok: bool


def test_agent_tool_loop_executes_tool(settings):
    calls = []

    def remember(value: str) -> str:
        calls.append(value)
        return "ok"

    registry = ToolRegistry(
        [
            Tool(
                name="remember",
                description="remember a value",
                parameters={"type": "object"},
                handler=remember,
            )
        ]
    )
    llm = ScriptedLLM(
        [
            LLMResponse(
                text="",
                tool_calls=[
                    ToolCall(id="1", name="remember", arguments={"value": "hi"})
                ],
            ),
            LLMResponse(text='{"ok": true}'),
        ]
    )
    agent = Agent(AgentSpec(name="tester", role="tester", system_prompt="Test."), llm, settings, registry)
    result = agent.run("do it", schema=Answer)
    assert result.data == {"ok": True}
    assert calls == ["hi"]
    assert result.steps == 2


def test_agent_retries_invalid_json(settings):
    llm = ScriptedLLM(
        [
            LLMResponse(text="not json"),
            LLMResponse(text='{"ok": true}'),
        ]
    )
    agent = Agent(AgentSpec(name="tester", role="tester", system_prompt="Test."), llm, settings)
    result = agent.run("do it", schema=Answer)
    assert result.data == {"ok": True}


def test_agent_reports_unknown_tool(settings):
    registry = ToolRegistry(
        [
            Tool(
                name="known",
                description="known",
                parameters={"type": "object"},
                handler=lambda **_: "ok",
            )
        ]
    )
    llm = ScriptedLLM(
        [
            LLMResponse(text="", tool_calls=[ToolCall(id="1", name="nope", arguments={})]),
            LLMResponse(text='{"ok": true}'),
        ]
    )
    agent = Agent(AgentSpec(name="tester", role="tester", system_prompt="Test."), llm, settings, registry)
    result = agent.run("do it", schema=Answer)
    assert result.data == {"ok": True}


def test_run_agent_persists_audit_record(settings):
    llm = ScriptedLLM([LLMResponse(text='{"ok": true}')])
    agent = Agent(AgentSpec(name="tester", role="tester", system_prompt="Test."), llm, settings)
    with db.session(settings.db_path) as conn:
        workflow_id = db.create_workflow(conn, "test", "test")
    result = run_agent(
        settings,
        agent,
        workflow="test",
        role="tester",
        task="do it",
        schema=Answer,
        workflow_run_id=workflow_id,
    )
    assert result.data == {"ok": True}
    with db.session(settings.db_path) as conn:
        runs = db.list_agent_runs(conn, workflow_run_id=workflow_id)
    assert runs[0]["role"] == "tester"
    assert runs[0]["status"] == "ok"


def test_parse_json_object_variants():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_object('Here is the result: {"a": 2}') == {"a": 2}
    assert parse_json_object('{"a": 3,}') == {"a": 3}
    with pytest.raises(Exception):
        parse_json_object("not json at all")
