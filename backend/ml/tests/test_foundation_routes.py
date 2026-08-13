"""Unit tests for input validation in backend/ml/routes/foundation_routes.py.

Run with: python3 -m pytest tests/test_foundation_routes.py -v --no-header
"""
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routes.foundation_routes import (
    ALLOWED_MODEL_NAME_RE,
    ALLOWED_TASKS,
    _resolve_model_path,
)


class TestResolveModelPath:
    """Path validation must reject traversal and enforce the allowlist."""

    def test_plain_name_is_allowed(self):
        assert _resolve_model_path("foundation_model.pth") == os.path.join("models", "foundation_model.pth")

    def test_default_models_path_is_allowed(self):
        assert _resolve_model_path("models/foundation_model.pth") == os.path.join("models", "foundation_model.pth")

    def test_versioned_name_is_allowed(self):
        assert _resolve_model_path("foundation_model_v2.pth") == os.path.join("models", "foundation_model_v2.pth")

    @pytest.mark.parametrize("bad_path", [
        "../outside.pth",
        "..\\..\\outside.pth",
        "models/../../etc/outside.pth",
        "foundation_model.pth/..",
        "/etc/foundation_model.pth",
        "C:\\Windows\\foundation_model.pth",
        "C:foundation_model.pth",
        "models/other.pth",
        "foundation_model.txt",
        "foundation_model_v2.1.pth",
        "foundation_model_vX.pth",
    ])
    def test_invalid_paths_are_rejected(self, bad_path):
        with pytest.raises(HTTPException) as excinfo:
            _resolve_model_path(bad_path)
        assert excinfo.value.status_code == 400

    def test_allowlist_regex_matches_only_allowed_names(self):
        assert ALLOWED_MODEL_NAME_RE.match("foundation_model.pth")
        assert ALLOWED_MODEL_NAME_RE.match("foundation_model_v3.pth")
        assert not ALLOWED_MODEL_NAME_RE.match("other.pth")
        assert not ALLOWED_MODEL_NAME_RE.match("foundation_model_v3.txt")


class TestAllowedTasks:
    """The task allowlist must cover every head the model exposes."""

    def test_allowed_tasks(self):
        assert ALLOWED_TASKS == {"classification", "regression", "generation"}
