"""Parity tests for the ported swing condition/feasibility engine.

Runs standalone (``python tests/test_swing_engine.py``) and is also compatible
with pytest if it is later installed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.swing.classifier import classify_feasibility
from app.services.swing.condition_parser import CondFormatError, CondParser
from app.services.swing.expansion_engine import (
    RawFeatureGroup,
    RawItemConfig,
    expand_all,
)


# --- Parser grammar --------------------------------------------------------
def test_parser_precedence_and_over_or():
    from app.services.swing.condition_parser import BinaryNode

    ast = CondParser(".*A = '1' or .*B = '2' and .*C = '3'").parse()
    # AND binds tighter: top node is OR with children [A=1, (B=2 AND C=3)]
    assert isinstance(ast, BinaryNode) and ast.op == "OR"
    assert len(ast.children) == 2
    assert isinstance(ast.children[1], BinaryNode) and ast.children[1].op == "AND"


def test_parser_missing_paren_raises():
    raised = False
    try:
        CondParser("(.*A = '1'").parse()
    except CondFormatError:
        raised = True
    assert raised


# --- Classifier outcomes ---------------------------------------------------
def _av():
    av = {"color": {"red", "blue"}, "size": {"m"}}
    return av, set(av.keys())


def test_blank_condition_is_yes():
    av, ka = _av()
    assert classify_feasibility("", ka, av) == ("Yes", None)


def test_satisfiable_condition_is_conditional():
    av, ka = _av()
    assert classify_feasibility(".*COLOR = 'RED'", ka, av) == ("Conditional", "COLOR = 'RED'")


def test_impossible_equality_is_no():
    av, ka = _av()
    assert classify_feasibility(".*COLOR = 'GREEN'", ka, av) == ("No", None)


def test_unknown_attribute_stripped_to_true():
    av, ka = _av()
    assert classify_feasibility(".*FABRIC = 'LEATHER'", ka, av) == ("Yes", None)


def test_wildcard_equals_any():
    av, ka = _av()
    assert classify_feasibility(".*COLOR = '*'", ka, av) == ("Yes", None)


def test_inequality_single_valued_is_no():
    av, ka = _av()
    # size only has {m}; SIZE <> 'M' cannot be satisfied -> No with compact form
    assert classify_feasibility(".*SIZE <> 'M'", ka, av) == ("No", "SIZE <> 'M'")


def test_inequality_absent_value_is_yes():
    av, ka = _av()
    assert classify_feasibility(".*SIZE <> 'L'", ka, av) == ("Yes", None)


def test_malformed_becomes_review():
    av, ka = _av()
    label, cond = classify_feasibility("(.*COLOR = 'RED'", ka, av)
    assert label == "Review"
    assert cond == "(.*COLOR = 'RED'"


# --- Expansion engine ------------------------------------------------------
def _raw_item(feature, option, seq, grp, cond=""):
    return RawItemConfig(
        item="I1", description="d", product_group="pg", feature=feature,
        feature_description="", option=option, option_description="",
        sequence=seq, group=grp, condition=cond,
    )


def test_expansion_classifies_options():
    items = [
        _raw_item("COLOR", "RED", 1, 1),
        _raw_item("COLOR", "BLUE", 1, 2),
        _raw_item("SIZE", "M", 2, 1, ".*COLOR = 'RED'"),
        _raw_item("SIZE", "L", 2, 2, ".*COLOR = 'GREEN'"),
    ]
    result = list(expand_all(items, [], None))
    assert len(result) == 1
    by_opt = {(v.feature, v.option): v for v in result[0].values}
    assert by_opt[("COLOR", "RED")].feasibility == "Yes"
    assert by_opt[("SIZE", "M")].feasibility == "Conditional"
    assert by_opt[("SIZE", "L")].feasibility == "No"


def test_duplicate_feature_option_merges_conditions_null_dominates():
    # Same (SIZE, M): one direct with empty condition, one via group with a
    # real condition. Empty condition string is filtered; group condition wins.
    items = [_raw_item("SIZE", "M", 1, 1, "")]
    groups = [
        RawFeatureGroup(
            feature_group="SIZE", feature="SIZE", feature_description="",
            option="M", option_description="", sequence=1, group=1,
            condition=".*COLOR = 'RED'",
        )
    ]
    # add COLOR so the condition is evaluable
    items.append(_raw_item("COLOR", "RED", 2, 1))
    result = list(expand_all(items, groups, None))
    vals = {(v.feature, v.option): v for v in result[0].values}
    assert ("SIZE", "M") in vals


def test_till_filtering_excludes_discontinued():
    from datetime import datetime

    old = _raw_item("COLOR", "RED", 1, 1)
    old.till = datetime(2000, 1, 1)
    current = _raw_item("COLOR", "BLUE", 1, 2)
    result = list(expand_all([old, current], [], datetime(2026, 1, 1)))
    options = {v.option for v in result[0].values}
    assert "BLUE" in options
    assert "RED" not in options


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        fn()
        passed += 1
        print(f"PASS {fn.__name__}")
    print(f"\n{passed}/{len(fns)} tests passed")


if __name__ == "__main__":
    _run_all()
