"""Tests for hermes_cli.kanban_router and the auto-delegate pipeline."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_router as router
from hermes_cli.profiles import ProfileInfo


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _fake_aux_response(content: str):
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    return resp


def _mock_profiles(profiles_data: list[dict]):
    out = []
    for d in profiles_data:
        p = ProfileInfo(
            name=d["name"],
            path=Path(f"/fake/{d['name']}"),
            is_default=(d["name"] == "default"),
            gateway_running=False,
            description=d.get("description", ""),
        )
        out.append(p)
    return patch("hermes_cli.profiles.list_profiles", return_value=out)


def test_case_a_single_specialty(kanban_home):
    """Case A: Single specialty task (iOS/SwiftUI) auto-assigns the best matching profile."""
    profiles = [
        {"name": "ios-specialist", "description": "Expert in iOS and SwiftUI application development"},
        {"name": "backend-specialist", "description": "Python, Django, and database engineering"},
        {"name": "default", "description": "General assistant"},
    ]

    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "Focused bugfix task suited for mobile development",
        "candidates": [
            {
                "profile": "ios-specialist",
                "skill_match": 0.95,
                "tool_match": 0.90,
                "specialization_match": 0.95,
                "score": 0.94,
                "reason": "Direct match for SwiftUI and Hermes Mobile bugs",
            },
            {
                "profile": "backend-specialist",
                "skill_match": 0.1,
                "tool_match": 0.1,
                "specialization_match": 0.1,
                "score": 0.1,
                "reason": "Backend skills not applicable to SwiftUI",
            },
        ],
    }

    with kb.connect_closing() as conn:
        task_id = kb.create_task(
            conn,
            title="Corrigir um bug SwiftUI no Hermes Mobile",
            body="Views are misaligned when keyboard opens",
            triage=True,
        )

        with _mock_profiles(profiles), patch(
            "agent.auxiliary_client.call_llm",
            return_value=_fake_aux_response(json.dumps(llm_payload)),
        ):
            decision = router.auto_delegate_task(conn, task_id)

        assert decision.action == "assigned"
        assert decision.assigned_profile == "ios-specialist"
        assert decision.confidence_score == 0.94

        updated = kb.get_task(conn, task_id)
        assert updated.assignee == "ios-specialist"
        assert updated.status in ("todo", "ready")

        events = kb.list_events(conn, task_id)
        event_kinds = [e.kind for e in events]
        assert "auto_delegate_started" in event_kinds
        assert "auto_delegate_candidate" in event_kinds
        assert "auto_delegate_selected" in event_kinds


def test_case_b_domain_differentiation(kanban_home):
    """Case B: Musical/audio task differentiates and routes to specialized music profile."""
    profiles = [
        {"name": "talia-music", "description": "Music theory, guitar tablature, audio synthesis and effects analysis"},
        {"name": "coder", "description": "Full-stack software developer"},
        {"name": "default", "description": "General assistant"},
    ]

    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "Music theory and audio effects analysis",
        "candidates": [
            {
                "profile": "talia-music",
                "skill_match": 0.92,
                "tool_match": 0.85,
                "specialization_match": 0.98,
                "score": 0.92,
                "reason": "Has verified domain expertise in guitar tabs and audio effects",
            },
            {
                "profile": "coder",
                "skill_match": 0.20,
                "tool_match": 0.10,
                "specialization_match": 0.15,
                "score": 0.18,
                "reason": "General coder lacks specialized musical analysis capabilities",
            },
        ],
    }

    with kb.connect_closing() as conn:
        task_id = kb.create_task(
            conn,
            title="Encontrar a cifra e analisar os efeitos de guitarra de uma música gospel",
            triage=True,
        )

        with _mock_profiles(profiles), patch(
            "agent.auxiliary_client.call_llm",
            return_value=_fake_aux_response(json.dumps(llm_payload)),
        ):
            decision = router.auto_delegate_task(conn, task_id)

        assert decision.action == "assigned"
        assert decision.assigned_profile == "talia-music"

        updated = kb.get_task(conn, task_id)
        assert updated.assignee == "talia-music"


def test_case_c_multi_specialty_decomposition(kanban_home):
    """Case C: Multi-domain task decomposes into children with distinct assignees."""
    profiles = [
        {"name": "researcher", "description": "Competitive market intelligence and research"},
        {"name": "frontend-dev", "description": "HTML, CSS, Web landing page development"},
    ]

    llm_payload = {
        "is_multi_specialty": True,
        "rationale": "Task spans both market research and web development disciplines",
        "candidates": [],
    }

    decomp_mock_outcome = MagicMock()
    decomp_mock_outcome.ok = True
    decomp_mock_outcome.fanout = True
    decomp_mock_outcome.child_ids = ["t_child1", "t_child2"]

    with kb.connect_closing() as conn:
        task_id = kb.create_task(
            conn,
            title="Pesquisar três concorrentes do Hermes Mobile, definir diferenciação e implementar landing page",
            triage=True,
        )

        with _mock_profiles(profiles), patch(
            "agent.auxiliary_client.call_llm",
            return_value=_fake_aux_response(json.dumps(llm_payload)),
        ), patch(
            "hermes_cli.kanban_decompose.decompose_task",
            return_value=decomp_mock_outcome,
        ):
            decision = router.auto_delegate_task(conn, task_id)

        assert decision.action == "decomposed"
        assert decision.child_ids == ["t_child1", "t_child2"]

        events = kb.list_events(conn, task_id)
        kinds = [e.kind for e in events]
        assert "auto_delegate_decomposed" in kinds


def test_case_d_manual_override(kanban_home):
    """Case D: Explicit user assignee is preserved without auto-delegation override."""
    with kb.connect_closing() as conn:
        task_id = kb.create_task(
            conn,
            title="Update README",
            assignee="explicit-worker",
            triage=True,
        )

        decision = router.auto_delegate_task(conn, task_id)

        assert decision.action == "manual_override"
        assert decision.assigned_profile == "explicit-worker"

        task = kb.get_task(conn, task_id)
        assert task.assignee == "explicit-worker"

        events = kb.list_events(conn, task_id)
        kinds = [e.kind for e in events]
        assert "auto_delegate_override" in kinds
        assert "auto_delegate_selected" not in kinds


def test_case_e_no_match_fail_closed(kanban_home):
    """Case E: No profile meets confidence threshold -> fails closed in triage."""
    profiles = [
        {"name": "ios-specialist", "description": "Swift and iOS developer"},
    ]

    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "Quantum physics paper review not supported by any active profile",
        "candidates": [
            {
                "profile": "ios-specialist",
                "skill_match": 0.1,
                "tool_match": 0.0,
                "specialization_match": 0.0,
                "score": 0.05,
                "reason": "Irrelevant specialization",
            }
        ],
    }

    with kb.connect_closing() as conn:
        task_id = kb.create_task(
            conn,
            title="Review a quantum physics arXiv paper on superconductivity",
            triage=True,
        )

        with _mock_profiles(profiles), patch(
            "agent.auxiliary_client.call_llm",
            return_value=_fake_aux_response(json.dumps(llm_payload)),
        ):
            decision = router.auto_delegate_task(conn, task_id, threshold=0.65)

        assert decision.action == "no_match"
        assert decision.confidence_score == 0.05

        # Fail closed: Task must remain in triage and unassigned
        task = kb.get_task(conn, task_id)
        assert task.status == "triage"
        assert task.assignee is None

        events = kb.list_events(conn, task_id)
        kinds = [e.kind for e in events]
        assert "auto_delegate_no_match" in kinds
        assert "auto_delegate_selected" not in kinds


def test_rest_create_with_auto_delegate(kanban_home):
    """Test POST /api/plugins/kanban/tasks with assignment_mode='auto'."""
    from starlette.testclient import TestClient
    from plugins.kanban.dashboard.plugin_api import router as kanban_router_api
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(kanban_router_api, prefix="/api/plugins/kanban")
    client = TestClient(app)

    profiles = [
        {"name": "ios-specialist", "description": "Expert in iOS and SwiftUI"},
    ]
    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "SwiftUI bugfix",
        "candidates": [
            {
                "profile": "ios-specialist",
                "skill_match": 0.95,
                "tool_match": 0.90,
                "specialization_match": 0.95,
                "score": 0.95,
                "reason": "SwiftUI expert",
            }
        ],
    }

    with _mock_profiles(profiles), patch(
        "agent.auxiliary_client.call_llm",
        return_value=_fake_aux_response(json.dumps(llm_payload)),
    ):
        res = client.post(
            "/api/plugins/kanban/tasks",
            json={
                "title": "Fix SwiftUI Navigation Bug",
                "assignment_mode": "auto",
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["task"]["assignee"] == "ios-specialist"
        assert "routing" in data
        assert data["routing"]["action"] == "assigned"
        assert data["routing"]["assigned_profile"] == "ios-specialist"


def test_rest_post_auto_delegate_endpoint(kanban_home):
    """Test POST /api/plugins/kanban/tasks/{task_id}/auto-delegate."""
    from starlette.testclient import TestClient
    from plugins.kanban.dashboard.plugin_api import router as kanban_router_api
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(kanban_router_api, prefix="/api/plugins/kanban")
    client = TestClient(app)

    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Audit iOS memory leak", triage=True)

    profiles = [
        {"name": "ios-specialist", "description": "iOS memory and Instruments"},
    ]
    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "Memory profiling",
        "candidates": [
            {
                "profile": "ios-specialist",
                "skill_match": 0.90,
                "tool_match": 0.85,
                "specialization_match": 0.90,
                "score": 0.91,
                "reason": "Instruments and memory leak expert",
            }
        ],
    }

    with _mock_profiles(profiles), patch(
        "agent.auxiliary_client.call_llm",
        return_value=_fake_aux_response(json.dumps(llm_payload)),
    ):
        res = client.post(f"/api/plugins/kanban/tasks/{task_id}/auto-delegate")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["action"] == "assigned"
        assert data["assigned_profile"] == "ios-specialist"
        assert data["task"]["assignee"] == "ios-specialist"


def test_cli_auto_delegate_command(kanban_home, capsys):
    """Test hermes kanban auto-delegate CLI command."""
    from hermes_cli.kanban import kanban_command
    import argparse

    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Analyze core audio issue", triage=True)

    profiles = [
        {"name": "audio-coder", "description": "CoreAudio and DSP developer"},
    ]
    llm_payload = {
        "is_multi_specialty": False,
        "rationale": "CoreAudio",
        "candidates": [
            {
                "profile": "audio-coder",
                "skill_match": 0.92,
                "tool_match": 0.88,
                "specialization_match": 0.95,
                "score": 0.93,
                "reason": "CoreAudio expert",
            }
        ],
    }

    args = argparse.Namespace(
        kanban_action="auto-delegate",
        task_id=task_id,
        threshold=0.6,
        force=False,
        author="test-cli",
        json=True,
        board=None,
    )

    with _mock_profiles(profiles), patch(
        "agent.auxiliary_client.call_llm",
        return_value=_fake_aux_response(json.dumps(llm_payload)),
    ):
        code = kanban_command(args)
        assert code == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["action"] == "assigned"
        assert data["assigned_profile"] == "audio-coder"

