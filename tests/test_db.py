from __future__ import annotations

from career_firm import db
from career_firm.documents.render import render_cv
from career_firm.documents.heuristics import analyze_job_heuristic, parse_cv_heuristic, tailor_heuristic


def test_repository_round_trip(settings, profile_id, sample_cv, sample_jd, tmp_path):
    with db.session(settings.db_path) as conn:
        cv_id = db.add_cv(
            conn,
            profile_id=profile_id,
            vertical="AI Platforms",
            filename="jane.docx",
            file_path=str(tmp_path / "jane.docx"),
            mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            raw_text=sample_cv,
            structured_json=parse_cv_heuristic(sample_cv).model_dump_json(),
        )
        job_id = db.create_job(
            conn,
            profile_id=profile_id,
            title="VP Engineering",
            company="Nimbus AI",
            description=sample_jd,
            language="en",
        )
        parsed = parse_cv_heuristic(sample_cv)
        analysis = analyze_job_heuristic(sample_jd, sample_cv)
        analysis_id = db.save_analysis(
            conn,
            job_id=job_id,
            cv_version_id=cv_id,
            score=analysis.match_score,
            verdict=analysis.match_level,
            payload=analysis.model_dump(),
        )
        cv = tailor_heuristic(parsed, analysis, sample_cv, "leader")
        rendered = render_cv(cv, tmp_path, "out")
        gen_id = db.save_generated_cv(
            conn,
            job_id=job_id,
            analysis_id=analysis_id,
            language="en",
            docx_path=rendered["docx_path"],
            pdf_path=rendered["pdf_path"],
            content=cv.model_dump(),
            warnings=[],
        )
        wf_id = db.create_workflow(conn, "tailor", "test", {"job_id": job_id})
        run_id = db.start_agent_run(conn, wf_id, "tailoring", "headhunter", {"task": "x"}, "mock", "mock")
        db.finish_agent_run(conn, run_id, "ok", {"score": 80}, prompt_tokens=1, completion_tokens=2)
        db.save_artifact(conn, wf_id, run_id, "a.md", "markdown", "hello")

    with db.session(settings.db_path) as conn:
        assert db.get_cv(conn, cv_id)["vertical"] == "AI Platforms"
        assert db.get_job(conn, job_id)["status"] == "queued"
        assert db.latest_analysis(conn, job_id)["score"] == analysis.match_score
        assert len(db.list_generated(conn, job_id)) == 1
        runs = db.list_agent_runs(conn, workflow_run_id=wf_id)
        assert runs[0]["status"] == "ok"
        assert runs[0]["prompt_tokens"] == 1
        assert db.list_artifacts(conn, wf_id)[0]["content"] == "hello"
        stats = db.stats(conn)
        assert stats["cv_versions"] == 1
        assert stats["jobs"] == 1
        assert stats["generated_cvs"] == 1
        assert db.get_generated(conn, gen_id)["warnings"] == []
