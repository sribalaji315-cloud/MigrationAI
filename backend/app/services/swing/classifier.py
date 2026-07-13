"""Feasibility classifier — faithful Python port of the reference
``SwingExpansionEngine.ClassifyFeasibility``.

Returns a ``(label, condition)`` tuple where ``label`` is one of
``"Yes" | "No" | "Conditional" | "Review"`` (matching the labels already used
by MigrationAI) and ``condition`` is the compact normalized expression to store
(or ``None`` for unconditional / literal-false outcomes).
"""

from __future__ import annotations

import re
from typing import Dict, Optional, Set, Tuple

from .condition_parser import CondParser
from .condition_simplifier import (
    is_feasible,
    is_literal_false,
    is_literal_true,
    reduce,
    strip,
    to_compact,
)

_LINE_ENDINGS = re.compile(r"\r\n|\r|\n")


def classify_feasibility(
    raw_condition: Optional[str],
    known_attrs: Set[str],
    attr_values: Dict[str, Set[str]],
) -> Tuple[str, Optional[str]]:
    if raw_condition is None or raw_condition.strip() == "":
        return ("Yes", None)

    try:
        ast = CondParser(raw_condition).parse()
        stripped = strip(ast, known_attrs)
        reduced = reduce(stripped, attr_values)

        if is_literal_true(reduced):
            return ("Yes", None)

        if is_literal_false(reduced) or not is_feasible(reduced, attr_values):
            return ("No", None if is_literal_false(reduced) else to_compact(reduced))

        return ("Conditional", to_compact(reduced))
    except Exception:
        return ("Review", _LINE_ENDINGS.sub(" ", raw_condition).strip())
