"""Kanban Auto-Delegate Router — deterministic capability analysis & profile routing.

Connects task creation/triage with intelligent profile selection, confidence-scored
assignment, multi-specialty decomposition, and fail-closed safety.

Architectural Guarantees:
1. Reuses existing Hermes primitives (profiles, profile_describer skills, kanban_decompose).
2. Fail-closed: Never assigns an arbitrary profile when confidence is below threshold.
3. Manual override: Explicit user-specified assignee is always preserved without overwrite.
4. Multi-specialty decomposition: Tasks spanning disparate domains fan out into child tasks.
5. Observability: Records structured audit events in task_events.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from hermes_cli import kanban_db as kb
from hermes_cli import profiles as profiles_mod
from hermes_cli.profile_describer import _collect_skills

logger = logging.getLogger(__name__)

DEFAULT_CONFIDENCE_THRESHOLD = 0.65

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)

_ROUTER_SYSTEM_PROMPT = """You are the Kanban Auto-Delegate Router for Hermes Agent.
Your job is to analyze a task, determine if it spans multiple disparate specialties,
and evaluate available profile candidates based on their actual skills, toolsets,
and declared specialization.

Output a single JSON object matching this schema:
{
  "is_multi_specialty": <true if task clearly spans multiple distinct specialties requiring decomposition, false if single-domain unit>,
  "rationale": "<one sentence explaining the analysis>",
  "candidates": [
    {
      "profile": "<profile name>",
      "skill_match": <float 0.0 to 1.0>,
      "tool_match": <float 0.0 to 1.0>,
      "specialization_match": <float 0.0 to 1.0>,
      "score": <float 0.0 to 1.0, weighted capability match>,
      "reason": "<short justification: matching skills, tools, or domain>"
    }
  ]
}

Rules:
1. Match tasks strictly against the profile's declared skills, description, and toolsets.
2. NEVER assume or invent skills that are not present in the candidate metadata.
3. If no candidate has relevant skills or domain knowledge, assign low scores (< 0.5) to all candidates.
4. Set "is_multi_specialty": true ONLY when the task explicitly requires multiple distinct domains that cannot reasonably be executed by a single specialist.
5. Do NOT include private chain-of-thought in "reason". Keep it concise and fact-based.
6. Output only the JSON object, with no markdown code fences or conversational prose.
"""

_ROUTER_USER_TEMPLATE = """Task ID: {task_id}
Title: {title}
Body:
{body}
Declared Skills Requested: {skills}
Project ID: {project_id}

Candidate Profiles:
{candidates_roster}
"""


@dataclass
class CandidateScore:
    profile: str
    score: float
    skill_match: float = 0.0
    tool_match: float = 0.0
    specialization_match: float = 0.0
    reason: str = ""


@dataclass
class RoutingDecision:
    task_id: str
    action: str  # "assigned", "decomposed", "no_match", "manual_override", "failed"
    assigned_profile: Optional[str] = None
    confidence_score: Optional[float] = None
    assignment_reason: Optional[str] = None
    candidates: list[CandidateScore] = field(default_factory=list)
    child_ids: list[str] = field(default_factory=list)
    error: Optional[str] = None


def _load_router_config() -> dict:
    try:
        from hermes_cli.config import load_config
        return load_config() or {}
    except Exception:
        return {}


def _resolve_confidence_threshold(cfg: Optional[dict] = None) -> float:
    if cfg is None:
        cfg = _load_router_config()
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    raw = kanban_cfg.get("auto_delegate_threshold")
    if raw is not None:
        try:
            val = float(raw)
            if 0.0 <= val <= 1.0:
                return val
        except (ValueError, TypeError):
            pass
    return DEFAULT_CONFIDENCE_THRESHOLD


def _extract_json_blob(raw: str) -> Optional[dict]:
    if not raw:
        return None
    stripped = _FENCE_RE.sub("", raw.strip())
    first = stripped.find("{")
    last = stripped.rfind("}")
    if first == -1 or last == -1 or last <= first:
        return None
    try:
        val = json.loads(stripped[first : last + 1])
        return val if isinstance(val, dict) else None
    except (ValueError, json.JSONDecodeError):
        return None


def load_profile_candidates(conn: Optional[Any] = None) -> list[dict[str, Any]]:
    """Load valid, executable profile candidates with runtime capability metadata."""
    candidates: list[dict[str, Any]] = []
    try:
        all_profiles = profiles_mod.list_profiles()
    except Exception as exc:
        logger.warning("kanban_router: failed to list profiles: %s", exc)
        return candidates

    workload_map: dict[str, int] = {}
    if conn is not None:
        try:
            cursor = conn.execute(
                "SELECT assignee, COUNT(*) as cnt FROM tasks WHERE status = 'running' AND assignee IS NOT NULL GROUP BY assignee"
            )
            for row in cursor.fetchall():
                workload_map[row["assignee"]] = int(row["cnt"])
        except Exception:
            pass

    for p in all_profiles:
        profile_skills = _collect_skills(p.path)
        toolsets: list[str] = []
        try:
            p_cfg_path = p.path / "config.yaml"
            if p_cfg_path.is_file():
                import yaml
                with open(p_cfg_path, "r", encoding="utf-8") as f:
                    p_cfg = yaml.safe_load(f) or {}
                toolsets = p_cfg.get("toolsets", [])
        except Exception:
            pass

        candidates.append({
            "name": p.name,
            "description": (p.description or "").strip(),
            "skills": profile_skills,
            "toolsets": toolsets,
            "model": p.model or "",
            "workload": workload_map.get(p.name, 0),
        })

    return candidates


def _format_candidates_roster(candidates: list[dict[str, Any]]) -> str:
    if not candidates:
        return "  (no profiles available)"
    lines = []
    for c in candidates:
        skills_str = ", ".join(c["skills"][:20]) if c["skills"] else "none"
        toolsets_str = ", ".join(c["toolsets"]) if c["toolsets"] else "default"
        lines.append(
            f"- Profile '{c['name']}':\n"
            f"  Description: {c['description'] or 'none'}\n"
            f"  Skills: {skills_str}\n"
            f"  Toolsets: {toolsets_str}\n"
            f"  Current Running Tasks: {c['workload']}"
        )
    return "\n".join(lines)


def score_candidates_with_llm(
    task_id: str,
    title: str,
    body: str,
    skills: list[str],
    project_id: Optional[str],
    candidates: list[dict[str, Any]],
    timeout: Optional[int] = None,
) -> tuple[bool, str, list[CandidateScore]]:
    """Query auxiliary LLM to evaluate capability scores across profiles."""
    try:
        from agent.auxiliary_client import call_llm
    except Exception as exc:
        logger.debug("kanban_router: auxiliary client import failed: %s", exc)
        return False, "auxiliary client unavailable", []

    user_msg = _ROUTER_USER_TEMPLATE.format(
        task_id=task_id,
        title=title[:400],
        body=(body or "(no body)")[:3000],
        skills=", ".join(skills) if skills else "none",
        project_id=project_id or "none",
        candidates_roster=_format_candidates_roster(candidates),
    )

    try:
        resp = call_llm(
            task="kanban_decomposer",
            messages=[
                {"role": "system", "content": _ROUTER_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.2,
            max_tokens=2000,
            timeout=timeout or 60,
        )
        content = resp.choices[0].message.content or ""
    except Exception as exc:
        logger.warning("kanban_router: LLM evaluation failed: %s", exc)
        return False, f"LLM error: {exc}", []

    parsed = _extract_json_blob(content)
    if not parsed or not isinstance(parsed, dict):
        return False, "Malformed JSON from router LLM", []

    is_multi = bool(parsed.get("is_multi_specialty", False))
    rationale = str(parsed.get("rationale", ""))
    raw_candidates = parsed.get("candidates", [])

    candidate_scores: list[CandidateScore] = []
    if isinstance(raw_candidates, list):
        for rc in raw_candidates:
            if not isinstance(rc, dict):
                continue
            name = str(rc.get("profile", "")).strip()
            if not name:
                continue
            try:
                score = float(rc.get("score", 0.0))
            except (ValueError, TypeError):
                score = 0.0
            candidate_scores.append(
                CandidateScore(
                    profile=name,
                    score=max(0.0, min(1.0, score)),
                    skill_match=float(rc.get("skill_match", 0.0) or 0.0),
                    tool_match=float(rc.get("tool_match", 0.0) or 0.0),
                    specialization_match=float(rc.get("specialization_match", 0.0) or 0.0),
                    reason=str(rc.get("reason", "")).strip(),
                )
            )

    candidate_scores.sort(key=lambda x: x.score, reverse=True)
    return is_multi, rationale, candidate_scores


def auto_delegate_task(
    conn: Any,
    task_id: str,
    *,
    threshold: Optional[float] = None,
    force: bool = False,
    author: str = "auto_delegate",
    timeout: Optional[int] = None,
) -> RoutingDecision:
    """Analyze a task and route it deterministically to the best matching profile."""
    task = kb.get_task(conn, task_id)
    if task is None:
        return RoutingDecision(task_id, "failed", error="task not found")

    cfg = _load_router_config()
    conf_threshold = threshold if threshold is not None else _resolve_confidence_threshold(cfg)

    # 1. Check for manual override
    if task.assignee and not force:
        kb._append_event(
            conn,
            task_id,
            "auto_delegate_override",
            {"assignee": task.assignee, "mode": "manual"},
        )
        return RoutingDecision(
            task_id=task_id,
            action="manual_override",
            assigned_profile=task.assignee,
            assignment_reason="Manual assignee specified by user",
        )

    # 2. Record audit start
    kb._append_event(
        conn,
        task_id,
        "auto_delegate_started",
        {"assignment_mode": "auto", "threshold": conf_threshold},
    )

    candidates = load_profile_candidates(conn)
    if not candidates:
        kb._append_event(
            conn,
            task_id,
            "auto_delegate_no_match",
            {"reason": "No active profile candidates available", "threshold": conf_threshold},
        )
        return RoutingDecision(
            task_id=task_id,
            action="no_match",
            assignment_reason="No profile candidates available",
        )

    # 3. Score candidates
    task_skills: list[str] = getattr(task, "skills", None) or []
    is_multi, rationale, scores = score_candidates_with_llm(
        task_id=task_id,
        title=task.title or "",
        body=task.body or "",
        skills=task_skills,
        project_id=getattr(task, "project_id", None),
        candidates=candidates,
        timeout=timeout,
    )

    # Record candidate evaluations
    kb._append_event(
        conn,
        task_id,
        "auto_delegate_candidate",
        {
            "is_multi_specialty": is_multi,
            "rationale": rationale,
            "candidates": [
                {"profile": c.profile, "score": c.score, "reason": c.reason}
                for c in scores
            ],
        },
    )

    # 4. Multi-specialty decomposition path
    if is_multi:
        try:
            from hermes_cli import kanban_decompose as decomp
            outcome = decomp.decompose_task(task_id, author=author, timeout=timeout)
            if outcome.ok and outcome.fanout and outcome.child_ids:
                kb._append_event(
                    conn,
                    task_id,
                    "auto_delegate_decomposed",
                    {"child_ids": outcome.child_ids, "rationale": rationale},
                )
                return RoutingDecision(
                    task_id=task_id,
                    action="decomposed",
                    assignment_reason=f"Multi-specialty task fanned out into {len(outcome.child_ids)} subtasks",
                    child_ids=outcome.child_ids,
                    candidates=scores,
                )
        except Exception as exc:
            logger.warning("kanban_router: decompose fallback failed: %s", exc)

    # 5. Single specialty matching & confidence threshold
    valid_names = {c["name"] for c in candidates}
    best_candidate: Optional[CandidateScore] = None
    for cs in scores:
        if cs.profile in valid_names and cs.score >= conf_threshold:
            best_candidate = cs
            break

    if best_candidate is not None:
        # Atomic assignment and promotion
        assigned_profile = best_candidate.profile
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET assignee = ? WHERE id = ?",
                (assigned_profile, task_id),
            )
            # If still in triage, promote to todo
            if task.status == "triage":
                conn.execute(
                    "UPDATE tasks SET status = 'todo' WHERE id = ? AND status = 'triage'",
                    (task_id,),
                )
            kb._append_event(
                conn,
                task_id,
                "auto_delegate_selected",
                {
                    "assignee": assigned_profile,
                    "score": best_candidate.score,
                    "reason": best_candidate.reason,
                    "assignment_mode": "auto",
                    "assigned_by": "auto_delegate",
                },
            )
            kb._append_event(
                conn,
                task_id,
                "assigned",
                {"assignee": assigned_profile, "author": author},
            )

        # Trigger recompute ready so parent-free task promotes to ready immediately
        kb.recompute_ready(conn)

        return RoutingDecision(
            task_id=task_id,
            action="assigned",
            assigned_profile=assigned_profile,
            confidence_score=best_candidate.score,
            assignment_reason=best_candidate.reason,
            candidates=scores,
        )

    # 6. Fail-closed: No candidate meets confidence threshold
    top_score = scores[0].score if scores else 0.0
    kb._append_event(
        conn,
        task_id,
        "auto_delegate_no_match",
        {
            "reason": f"Top candidate score ({top_score:.2f}) below threshold ({conf_threshold:.2f})",
            "top_score": top_score,
            "threshold": conf_threshold,
        },
    )
    return RoutingDecision(
        task_id=task_id,
        action="no_match",
        confidence_score=top_score,
        assignment_reason=f"No matching profile met confidence threshold {conf_threshold:.2f}",
        candidates=scores,
    )
