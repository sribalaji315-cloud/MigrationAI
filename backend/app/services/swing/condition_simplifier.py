"""Condition simplifier / feasibility evaluator — faithful Python port of the
reference ``CondAnalyzer`` (ToCompact) and ``CondSimplifier`` (Strip / Reduce /
IsFeasible).

Case-insensitivity: the reference uses ``OrdinalIgnoreCase`` hash sets for both
attribute names and values. Here, callers pass ``attr_values`` / ``known_attrs``
with **lowercased** keys and **lowercased** value sets, and this module lowercases
comparison operands accordingly. Original attribute/value text is preserved on
the AST nodes so :func:`to_compact` renders the canonical form unchanged.
"""

from __future__ import annotations

from typing import Dict, List, Set

from .condition_parser import BinaryNode, ComparisonNode, LiteralNode

_TRUE = LiteralNode(True)
_FALSE = LiteralNode(False)


def is_literal_true(node) -> bool:
    return isinstance(node, LiteralNode) and node.value is True


def is_literal_false(node) -> bool:
    return isinstance(node, LiteralNode) and node.value is False


def to_compact(node) -> str:
    if isinstance(node, LiteralNode):
        return "TRUE" if node.value else "FALSE"
    if isinstance(node, ComparisonNode):
        if node.value == "*":
            return f"{node.attribute} {node.op} ANY"
        return f"{node.attribute} {node.op} '{node.value}'"
    if isinstance(node, BinaryNode):
        inner = f" {node.op} ".join(to_compact(c) for c in node.children)
        return f"({inner})"
    return "?"


# --- Strip: drop unknown attributes (treat as TRUE) ------------------------
def strip(node, known_attrs: Set[str]):
    if isinstance(node, LiteralNode):
        return node
    if isinstance(node, ComparisonNode):
        return node if node.attribute.lower() in known_attrs else _TRUE
    if isinstance(node, BinaryNode):
        if node.op == "AND":
            return _simplify_and([strip(c, known_attrs) for c in node.children])
        if node.op == "OR":
            return _simplify_or([strip(c, known_attrs) for c in node.children])
    return node


def _simplify_and(children: List[object]):
    filtered = [c for c in children if not is_literal_true(c)]
    if any(is_literal_false(c) for c in filtered):
        return _FALSE
    if len(filtered) == 0:
        return _TRUE
    if len(filtered) == 1:
        return filtered[0]
    return BinaryNode("AND", filtered)


def _simplify_or(children: List[object]):
    filtered = [c for c in children if not is_literal_false(c)]
    if any(is_literal_true(c) for c in filtered):
        return _TRUE
    if len(filtered) == 0:
        return _FALSE
    if len(filtered) == 1:
        return filtered[0]
    return BinaryNode("OR", filtered)


# --- Reduce: fold comparisons against available value domains --------------
def reduce(node, attr_values: Dict[str, Set[str]]):
    if isinstance(node, LiteralNode):
        return node
    if isinstance(node, ComparisonNode):
        return _reduce_comparison(node, attr_values)
    if isinstance(node, BinaryNode):
        if node.op == "AND":
            return _simplify_and([reduce(c, attr_values) for c in node.children])
        if node.op == "OR":
            return _simplify_or([reduce(c, attr_values) for c in node.children])
    return node


def _reduce_comparison(c: ComparisonNode, attr_values: Dict[str, Set[str]]):
    available = attr_values.get(c.attribute.lower())
    if available is None:
        return _FALSE if c.op == "=" else _TRUE

    if c.value == "*":
        if c.op == "=":
            return _TRUE if len(available) > 0 else _FALSE
        return _FALSE if len(available) > 0 else _TRUE

    if c.op == "=":
        return c if c.value.lower() in available else _FALSE
    return c if c.value.lower() in available else _TRUE


# --- IsFeasible ------------------------------------------------------------
def is_feasible(node, attr_values: Dict[str, Set[str]]) -> bool:
    if isinstance(node, LiteralNode):
        return node.value
    if isinstance(node, ComparisonNode):
        return _is_feasible_comparison(node, attr_values)
    if isinstance(node, BinaryNode):
        if node.op == "OR":
            return any(is_feasible(c, attr_values) for c in node.children)
        if node.op == "AND":
            return _is_feasible_and(node.children, attr_values)
    return False


def _is_feasible_comparison(c: ComparisonNode, attr_values: Dict[str, Set[str]]) -> bool:
    if c.value == "*":
        if c.op == "=":
            return c.attribute.lower() in attr_values
        return c.attribute.lower() not in attr_values

    vals = attr_values.get(c.attribute.lower())
    if vals is None:
        return c.op == "<>"

    target = c.value.lower()
    if c.op == "=":
        return target in vals
    # "<>": reference uses "any value not equal" for multi-valued attributes.
    return any(v != target for v in vals)


def _is_feasible_and(children: List[object], attr_values: Dict[str, Set[str]]) -> bool:
    leaf_comparisons: List[ComparisonNode] = []
    complex_children: List[object] = []
    for child in children:
        if isinstance(child, ComparisonNode):
            leaf_comparisons.append(child)
        else:
            complex_children.append(child)

    # Group leaf comparisons by attribute (case-insensitive), preserving order.
    groups: Dict[str, List[ComparisonNode]] = {}
    order: List[str] = []
    for comp in leaf_comparisons:
        key = comp.attribute.lower()
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(comp)

    for key in order:
        group = groups[key]
        available = attr_values.get(key)
        if available is None:
            if any(c.op == "=" and c.value != "*" for c in group):
                return False
            continue

        must_be = {c.value.lower() for c in group if c.op == "=" and c.value != "*"}
        must_not_be = {c.value.lower() for c in group if c.op == "<>" and c.value != "*"}
        has_wildcard_neq = any(c.op == "<>" and c.value == "*" for c in group)

        if has_wildcard_neq and len(available) > 0:
            return False

        if len(must_be) > 0:
            if not any(v in available and v not in must_not_be for v in must_be):
                return False
        elif len(must_not_be) > 0:
            if not any(v not in must_not_be for v in available):
                return False

    for child in complex_children:
        if not is_feasible(child, attr_values):
            return False

    return True
