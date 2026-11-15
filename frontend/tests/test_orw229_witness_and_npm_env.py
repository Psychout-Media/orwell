"""ORW-229 (#2288 review nits) — what the install record treats as an input, and what it notices on disk.

1. The npm environment and config that change what `npm ci` installs are part of the engine's dependency
   fingerprint: npm_config_* / NPM_CONFIG_* (registry and friends), ONNXRUNTIME_NODE_INSTALL, NODE_ENV and the
   user / global npmrc. A change to any of them means the full `npm ci`; an unrelated variable changes nothing.
2. The on-disk witnesses notice a package file edited in place (path, size and mtime of every file), not only
   npm's hidden lockfile or the venv's distribution list.
Runs the REAL update script in the sandboxed box of test_orw229_update_fast_path.py. Name-agnostic: roles only.
"""
import os

import pytest

from test_orw229_update_fast_path import _npm_work, _pip, _recorded, _update, _combined, fbox, pytestmark  # noqa: F401


@pytest.mark.parametrize("env, label", [
    ({"NPM_CONFIG_REGISTRY": "https://registry.example.invalid/"}, "registry"),
    ({"npm_config_omit": "optional"}, "npm config"),
    ({"ONNXRUNTIME_NODE_INSTALL": "cuda12"}, "onnxruntime install mode"),
    ({"NODE_ENV": "production"}, "NODE_ENV"),
])
def test_npm_environment_that_changes_an_install_forces_the_full_npm_ci(fbox, env, label):
    _recorded(fbox)
    fbox.put(fe="3")                                          # nothing the engine reads changed...
    r, calls = _update(fbox, **env)                           # ...but the npm environment did
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls, f"{label}: a different install environment is a different install"


def test_a_changed_user_npmrc_forces_the_full_npm_ci(fbox):
    _recorded(fbox)
    (fbox.root / "home" / ".npmrc").write_text("registry=https://registry.example.invalid/\n")
    fbox.put(fe="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls


def test_an_unrelated_environment_variable_changes_nothing(fbox):
    _recorded(fbox)
    fbox.put(fe="3")
    r, calls = _update(fbox, SOME_UNRELATED_SETTING="1")
    assert r.returncode == 0, _combined(r)
    assert not _npm_work(calls) and not _pip(calls)


def test_a_package_file_edited_in_place_in_node_modules_forces_the_full_npm_ci(fbox):
    _recorded(fbox)
    f = fbox.app / "node_modules" / ".installed-from-lock"   # npm's hidden lockfile stays exactly as it was
    f.write_text(f.read_text() + "// edited in place\n")
    fbox.put(fe="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls, "the hidden lockfile alone would not have noticed"


def test_a_package_file_edited_in_place_in_the_venv_forces_pip(fbox):
    _recorded(fbox)
    pkg = fbox.site_packages() / "somepkg"
    pkg.mkdir(exist_ok=True)
    (pkg / "__init__.py").write_text("print('edited in place')\n")
    fbox.put(fe="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert _pip(calls), "the distribution list alone would not have noticed"


def test_bytecode_written_into_the_venv_is_not_a_change(fbox):
    _recorded(fbox)
    cache = fbox.site_packages() / "__pycache__"
    cache.mkdir(exist_ok=True)
    (cache / "mod.cpython-312.pyc").write_bytes(b"\x00bytecode")   # e.g. a root-run python importing a module
    fbox.put(fe="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert not _pip(calls)
