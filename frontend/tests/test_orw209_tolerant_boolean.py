"""ORW-209: Boolean columns that a legacy migration created as TEXT read '0' as True.

SQLAlchemy's stock Boolean result processor returns True for the string "0"; SQL filters
treated the same row as disabled, and an ORM "enable" was a silent no-op. TolerantBoolean
parses text spellings on read and leaves writes as ordinary booleans.
"""
import types

import pytest
from sqlalchemy import Boolean, Column, Integer, String, create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

from core.database import TolerantBoolean

Base = declarative_base()


class Row(Base):
    __tablename__ = "t_row"
    id = Column(Integer, primary_key=True)
    flag = Column(TolerantBoolean, default=True)


@pytest.fixture()
def env():
    eng = create_engine("sqlite://")
    with eng.begin() as c:
        # Legacy shape: the flag column is declared TEXT.
        c.execute(text("CREATE TABLE t_row (id INTEGER PRIMARY KEY, flag TEXT)"))
        c.execute(text("CREATE TABLE t_int (id INTEGER PRIMARY KEY, flag INTEGER)"))
    return eng, sessionmaker(bind=eng)


def test_text_zero_reads_false_and_one_reads_true(env):
    eng, S = env
    with eng.begin() as c:
        c.execute(text("INSERT INTO t_row VALUES (1,'0'),(2,'1'),(3,'false'),(4,' True '),(5,''),(6,NULL)"))
    with S() as s:
        got = {r.id: r.flag for r in s.query(Row).all()}
    assert got == {1: False, 2: True, 3: False, 4: True, 5: False, 6: None}


@pytest.mark.parametrize("raw,expected", [
    ("0", False), ("false", False), ("f", False), ("no", False), ("off", False),
    ("", False), ("none", False), ("null", False), (" FALSE ", False), ("None", False),
    ("1", True), ("true", True), ("t", True), ("yes", True), ("on", True), (" On ", True),
    (0, False), (1, True), (2, True),
])
def test_parse_table(raw, expected):
    assert TolerantBoolean()._parse(raw) is expected


def test_enable_write_lands_and_sql_agrees(env):
    eng, S = env
    with eng.begin() as c:
        c.execute(text("INSERT INTO t_row VALUES (1,'0')"))
    with S() as s:
        r = s.get(Row, 1)
        assert r.flag is False  # previously True -> the write below was a no-op
        r.flag = True
        s.commit()
    with S() as s:
        assert s.get(Row, 1).flag is True
        assert s.query(Row).filter(Row.flag == True).count() == 1  # noqa: E712
        assert s.query(Row).filter(Row.flag == False).count() == 0  # noqa: E712
    with eng.connect() as c:
        assert c.execute(text("SELECT count(*) FROM t_row WHERE flag = 1")).scalar() == 1


def test_disable_write_roundtrip(env):
    eng, S = env
    with eng.begin() as c:
        c.execute(text("INSERT INTO t_row VALUES (1,'1')"))
    with S() as s:
        r = s.get(Row, 1)
        r.flag = False
        s.commit()
    with S() as s:
        assert s.get(Row, 1).flag is False
        assert s.query(Row).filter(Row.flag == True).count() == 0  # noqa: E712


def test_integer_columns_unaffected(env):
    eng, S = env

    class IntRow(Base):
        __tablename__ = "t_int"
        id = Column(Integer, primary_key=True)
        flag = Column(TolerantBoolean, default=True)

    with eng.begin() as c:
        c.execute(text("INSERT INTO t_int VALUES (1,0),(2,1),(3,NULL)"))
    with S() as s:
        got = {r.id: r.flag for r in s.query(IntRow).all()}
    assert got == {1: False, 2: True, 3: None}


def test_no_stock_boolean_columns_remain():
    import core.database as d
    for tbl in d.Base.metadata.tables.values():
        for col in tbl.columns:
            if isinstance(col.type, Boolean):
                assert isinstance(col.type, TolerantBoolean), f"{tbl.name}.{col.name}"


def test_orphan_check_matches_text_enabled_endpoint(monkeypatch):
    """Regression: an endpoint stored with '1' text must still be found (session not orphaned)."""
    import core.database as d
    from routes import chat_routes
    from sqlalchemy.schema import CreateTable

    eng = create_engine("sqlite://")
    ddl = str(CreateTable(d.ModelEndpoint.__table__).compile(eng))
    assert "is_enabled BOOLEAN" in ddl
    with eng.begin() as c:
        # Legacy shape: is_enabled declared TEXT.
        c.execute(text(ddl.replace("is_enabled BOOLEAN", "is_enabled TEXT")))
        c.execute(text("INSERT INTO model_endpoints (id,name,base_url,is_enabled,owner,created_at,updated_at) "
                       "VALUES ('e1','A','https://api.example.test/v1','1','u1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),"
                       "('e2','B','https://off.example.test/v1','0','u1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
    S = sessionmaker(bind=eng)
    with S() as s:
        by_id = {e.id: e.is_enabled for e in s.query(d.ModelEndpoint).all()}
    assert by_id == {"e1": True, "e2": False}
    monkeypatch.setattr(chat_routes, "SessionLocal", S)

    sess = types.SimpleNamespace(id="s1", endpoint_url="https://api.example.test/v1/chat/completions",
                                 model="m", headers={"Authorization": "Bearer x"})
    assert chat_routes._clear_orphaned_session_endpoint(sess, "u1") is False
    assert sess.model == "m" and sess.headers
