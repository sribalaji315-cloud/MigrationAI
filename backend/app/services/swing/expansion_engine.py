"""Swing expansion engine — faithful Python port of the reference
``SwingExpansionEngine.ExpandAll``.

For each item it expands the item's direct feature options plus any inline
group-feature options, builds the item's attribute -> available-values domain,
de-duplicates by (Feature, Option) with direct options winning metadata and
OR-merged conditions, then classifies each value's feasibility/condition.

Only the fields needed by the downstream writer are retained on the output
(``item``, ``feature``, ``option``, ``feasibility``, ``condition``); the rest of
the reference's projection (descriptions, sequence, ordering, group flags) is
intentionally dropped because MigrationAI only updates feasibility/condition.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterator, List, Optional, Set

from .classifier import classify_feasibility


@dataclass
class RawItemConfig:
    item: str
    description: Optional[str]
    product_group: Optional[str]
    feature: str
    feature_description: str
    option: str
    option_description: str
    sequence: int
    group: int
    condition: str
    from_value: str = ""
    to_value: str = ""
    till: Optional[datetime] = None


@dataclass
class RawFeatureGroup:
    feature_group: str
    feature: str
    feature_description: str
    option: str
    option_description: str
    sequence: int
    group: int
    condition: str
    till: Optional[datetime] = None


@dataclass
class ExpandedValue:
    feature: str
    option: str
    feasibility: str
    condition: Optional[str]


@dataclass
class ExpandedItem:
    item: str
    values: List[ExpandedValue]


def _group_by(rows, key_fn):
    groups: Dict[object, List] = {}
    order: List[object] = []
    for row in rows:
        key = key_fn(row)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)
    return groups, order


def distinct_item_count(item_configs: List[RawItemConfig]) -> int:
    return len({c.item for c in item_configs})


def _merge_conditions(conditions: List[Optional[str]]) -> Optional[str]:
    if any(c is None for c in conditions):
        return None
    distinct: List[str] = []
    seen: Set[str] = set()
    for c in conditions:
        if c is not None and c.strip() != "":
            lc = c.lower()
            if lc not in seen:
                seen.add(lc)
                distinct.append(c)
    if len(distinct) == 0:
        return None
    if len(distinct) == 1:
        return distinct[0]
    return " or ".join(f"({c})" for c in distinct)


def expand_all(
    item_configs: List[RawItemConfig],
    feature_groups: List[RawFeatureGroup],
    import_date: Optional[datetime] = None,
) -> Iterator[ExpandedItem]:
    # Filter out discontinued rows (Till before import date).
    if import_date is not None:
        active_groups = [g for g in feature_groups if g.till is None or g.till >= import_date]
        active_item_configs = [c for c in item_configs if c.till is None or c.till >= import_date]
    else:
        active_groups = feature_groups
        active_item_configs = item_configs

    # Index feature groups by FeatureGroup name; per group order features by min
    # sequence, then within each feature order options by Group.
    feature_group_index: Dict[str, List[RawFeatureGroup]] = {}
    groups_by_name, name_order = _group_by(active_groups, lambda g: g.feature_group)
    for name in name_order:
        entries = groups_by_name[name]
        by_feature, feat_order = _group_by(entries, lambda x: x.feature)
        ordered_feats = sorted(
            feat_order, key=lambda f: min(r.sequence for r in by_feature[f])
        )
        flat: List[RawFeatureGroup] = []
        for feat in ordered_feats:
            flat.extend(sorted(by_feature[feat], key=lambda r: r.group))
        feature_group_index[name] = flat

    # Group item configs by Item.
    item_groups, item_order = _group_by(active_item_configs, lambda c: c.item)

    for item in item_order:
        item_rows = item_groups[item]

        # Group by Feature (min sequence), options ordered by Group.
        by_feature, feat_order = _group_by(item_rows, lambda c: c.feature)
        features = []
        for feat in feat_order:
            rows = by_feature[feat]
            features.append(
                {
                    "feature": feat,
                    "sequence": min(c.sequence for c in rows),
                    "options": sorted(rows, key=lambda c: c.group),
                }
            )
        features.sort(key=lambda f: f["sequence"])

        # expanded: (feature, option, from_group, condition)
        expanded = []
        for feature in features:
            for opt in feature["options"]:
                expanded.append((feature["feature"], opt.option, False, opt.condition))
            grp = feature_group_index.get(feature["feature"])
            if grp:
                for opt in grp:
                    expanded.append((opt.feature, opt.option, True, opt.condition))

        # Build attribute -> available values (indexed by full name and by the
        # suffix after the last underscore), all lowercased for case-insensitive
        # matching.
        attr_values: Dict[str, Set[str]] = {}
        for (feat, option, _from_group, _cond) in expanded:
            attr_values.setdefault(feat.lower(), set()).add(option.lower())
            underscore_idx = feat.rfind("_")
            if underscore_idx >= 0:
                normalized = feat[underscore_idx + 1:]
                if normalized:
                    attr_values.setdefault(normalized.lower(), set()).add(option.lower())
        known_attrs = set(attr_values.keys())

        # De-duplicate by (Feature, Option); direct options first so their
        # metadata wins, conditions OR-merged.
        expanded_sorted = sorted(expanded, key=lambda e: 1 if e[2] else 0)
        dedupe: Dict[tuple, dict] = {}
        dedupe_order: List[tuple] = []
        for (feat, option, _from_group, cond) in expanded_sorted:
            gkey = (feat.lower(), option.lower())
            if gkey not in dedupe:
                dedupe[gkey] = {"feature": feat, "option": option, "conditions": []}
                dedupe_order.append(gkey)
            dedupe[gkey]["conditions"].append(cond)

        condition_cache: Dict[str, tuple] = {}
        values: List[ExpandedValue] = []
        for gkey in dedupe_order:
            entry = dedupe[gkey]
            merged = _merge_conditions(entry["conditions"])
            cache_key = merged if merged is not None else ""
            classified = condition_cache.get(cache_key)
            if classified is None:
                classified = classify_feasibility(merged, known_attrs, attr_values)
                condition_cache[cache_key] = classified
            feasibility, condition = classified
            values.append(ExpandedValue(entry["feature"], entry["option"], feasibility, condition))

        yield ExpandedItem(item, values)
