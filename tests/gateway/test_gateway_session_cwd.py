"""Gateway-created session rows carry a usable ``cwd`` (#93625).

The desktop sidebar groups sessions by the ``sessions.cwd`` column. The gateway's
INSERT path used to never pass a cwd, so every messaging-platform row landed with
``cwd = NULL`` and fell out of every project lane — "my session history vanished".
These tests pin the two halves of the fix:

* ``_session_create_kwargs`` seeds ``cwd`` from the owning profile's configured
  ``terminal.cwd`` (placeholders resolved/skipped, mirroring tui_gateway's
  ``_default_session_cwd`` precedence).
* A one-time per-store backfill repairs legacy messaging rows that were minted
  before the seed existed (``state_meta`` gate, only NULL/empty rows).
"""

from pathlib import Path

from gateway.config import GatewayConfig, Platform
from gateway.session import SessionSource, SessionStore


def _make_db_store(tmp_path: Path) -> SessionStore:
    from hermes_state import SessionDB

    store = SessionStore(sessions_dir=tmp_path / "sessions", config=GatewayConfig())
    if store._db is not None:
        store._db.close()
    store._db = SessionDB(db_path=tmp_path / "state.db")
    return store


def _source(chat_id: str = "cwd-chat") -> SessionSource:
    return SessionSource(platform=Platform.SLACK, chat_id=chat_id, user_id="user-1")


def _row_cwd(db, session_id: str):
    row = db._conn.execute("SELECT cwd FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return None if row is None else row[0]


def test_gateway_session_rows_seed_cwd_at_creation(tmp_path, monkeypatch):
    """A messaging session created through the gateway's routing path records the
    configured terminal.cwd in the same INSERT as its identity, so the sidebar can
    group it from the first refresh."""
    store = _make_db_store(tmp_path)
    db = store._db
    monkeypatch.chdir(tmp_path)

    kwargs = store._session_create_kwargs(
        store,
        session_id="sess-cwd-1",
        session_key=store._generate_session_key(_source()),
        origin=_source(),
        source_value=Platform.SLACK.value,
        display_name="cwd chat",
        parent_session_id=None,
    )
    assert kwargs["cwd"], "create kwargs must seed a cwd for gateway rows"
    assert Path(kwargs["cwd"]).is_absolute()

    db.create_session(**kwargs)
    assert _row_cwd(db, "sess-cwd-1") == kwargs["cwd"]


def test_gateway_cwd_prefers_owning_profile_config(tmp_path, monkeypatch):
    """The profile-namespaced key reads ITS profile's terminal.cwd, not the launch
    profile's TERMINAL_CWD (the same #40334 rule tui_gateway applies)."""
    store = _make_db_store(tmp_path)
    profile_home = tmp_path / "profiles" / "research"
    profile_home.mkdir(parents=True)
    (profile_home / "config.yaml").write_text(f"terminal:\n  cwd: {tmp_path}\n")

    store._profile_home_cache["research"] = profile_home
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path / "launch-env-cwd"))

    key = "agent:research:slack:dm:cwd-chat"
    assert store._default_session_cwd_for_key(key) == str(tmp_path)

    # Placeholders are never persisted: the seed falls through to the next source.
    (profile_home / "config.yaml").write_text("terminal:\n  cwd: .\n")
    store._profile_home_cache.clear()
    monkeypatch.delenv("TERMINAL_CWD")
    store._routing_home = None
    assert store._default_session_cwd_for_key(key) == str(Path.cwd())


def test_legacy_gateway_rows_get_cwd_backfilled_once(tmp_path, monkeypatch):
    """Existing messaging rows with NULL cwd are repaired once per store with the
    same default a fresh row would record; non-messaging rows and rows with an
    explicit cwd are untouched, and the state_meta gate makes it idempotent."""
    store = _make_db_store(tmp_path)
    db = store._db
    monkeypatch.chdir(tmp_path)

    # Legacy rows: a slack row with no cwd (the #93625 picture), a desktop row
    # with no cwd (local surfaces own their cwd story — not ours to guess), and
    # a slack row that already carries one.
    db.create_session("legacy-slack", "slack", session_key="agent:main:slack:dm:legacy", cwd=None)
    db.create_session("legacy-desktop", "desktop", cwd=None)
    db.create_session("has-cwd", "slack", session_key="agent:main:slack:dm:kept", cwd="/already/here")

    key = store._generate_session_key(_source("legacy-chat"))
    store._backfill_legacy_gateway_session_cwd(key)

    assert _row_cwd(db, "legacy-slack") == str(Path.cwd())
    assert _row_cwd(db, "legacy-desktop") is None, "local-surface rows are not stamped by the gateway"
    assert _row_cwd(db, "has-cwd") == "/already/here"

    # Idempotent: the gate means a second transition never re-runs the UPDATE.
    db.create_session("legacy-slack-2", "slack", session_key="agent:main:slack:dm:late", cwd=None)
    store._backfill_legacy_gateway_session_cwd(key)
    assert _row_cwd(db, "legacy-slack-2") is None
    assert db.get_meta("gateway_session_cwd_backfilled") == "1"
