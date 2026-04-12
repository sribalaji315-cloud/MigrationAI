# Plan: Valuelist Reduction Strategy for Migration

## TL;DR
Minimize valuelist creation by classifying target attributes into FIXED_ONLY vs VALUELIST, then deduplicating identical value sets across attributes, and optionally merging near-identical lists via superset merge. Assignment happens at attribute level (not item level), with "effective fixed" tracking for single-value items under valuelist attributes.

## The Core Problem

In the target PLM system:
- Attributes and valuelists are bound at the ATTRIBUTE level
- Cannot assign a valuelist per item — all items see the same dropdown
- Single-value items are logically "fixed" but still get the valuelist if other items need it
- Goal: minimize total valuelists while respecting these constraints

## Pipeline (4 new steps after existing merge)

```
Existing: BOM → FeatureCombination → ConsolidationPlan → MergedWorkspaceMapping
New:      MergedWorkspaceMapping → Census → Classification → Dedup → Assignment
```

## Steps

### Phase A: Analysis (background job)

1. **Target Attribute Census** — For each `new_attribute_id` in MergedWorkspaceMapping, collect all resolved `new_value` entries grouped by item. Result: `{attribute → {item → [values]}}`. This pivots from legacy features to target attributes (multiple legacy features can map to one target attribute). *New model: `TargetAttributeProfile`*. *New job tracker: `ValuelistStrategyJob`*.

2. **Attribute Classification** — For each attribute, if max(values_per_item) == 1 → `fixed_only` (no valuelist). Otherwise → `valuelist` with canonical_values = union(all target values) minus noise (inherited from ConsolidationPlan). **Pre-filter**: exclude values where `new_value == "NOT REQUIRED"` or `value_status IN (ignored, deprecated, discontinued)` before counting cardinality or building canonical sets. Items with 0 remaining values after filtering are excluded from cardinality (not counted as fixed).

3. **Valuelist Deduplication** — Hash each sorted canonical value set (NOT REQUIRED and noise values already excluded). Attributes with identical hashes share one `valuelist_id`. This means two attributes that differ only by NOT REQUIRED entries produce the same hash and share a valuelist. E.g., 50 attributes with only 12 unique sets → 12 valuelists, not 50. *Automatic, no user input needed.*

### Phase B: Optional Optimization (user-driven)

4. **Superset Merge Preview** — Show user where ListA ⊂ ListB (merge A into B for free) or overlap(A,B) > threshold (merge creates minor noise). Display trade-off: "Merging these 3 lists into 1 adds 4 values to 12 items". Two strategies: *conservative* (subsets only, no noise) and *aggressive* (high-overlap, some noise). *User reviews and accepts.*

### Phase C: Commit

5. **Apply Strategy** — Create ValueList rows for each unique valuelist. Assign `valuelist_id` to TargetAttributeProfile and MergedWorkspaceMapping rows. Mark single-value items as `is_effective_fixed=true`. *Depends on steps 1-3, optionally 4.*

## Data Model Changes

### New table: `target_attribute_profiles`
| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | |
| target_attribute_id | String, unique, indexed | The `new_attribute_id` from mappings |
| classification | String | "fixed_only" or "valuelist" |
| valuelist_id | String, nullable | Assigned after dedup |
| total_items | Integer | |
| fixed_value_items | Integer | Items with exactly 1 value |
| multi_value_items | Integer | Items with >1 value |
| canonical_values_json | JSON | Union value set (excluding NOT REQUIRED) |
| noise_values_json | JSON, nullable | Removed noise values |
| dedup_group_key | String, nullable | Hash of sorted values for grouping |
| job_id | Integer, nullable | FK to ValuelistStrategyJob |
| created_at | Float | |
| updated_at | Float | |

### New table: `valuelist_strategy_jobs`
| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | |
| status | String | queued/running/completed/failed |
| strategy | String | conservative/aggressive |
| total_attributes | Integer | |
| fixed_only_count | Integer | |
| valuelist_count | Integer | |
| unique_valuelists | Integer | After dedup |
| merged_valuelists | Integer, nullable | After superset merge |
| error_message | String, nullable | |
| created_at | Float | |
| completed_at | Float, nullable | |

### Alter: `merged_workspace_mappings`
- ADD `valuelist_id` (String, nullable)
- ADD `is_effective_fixed` (Boolean, default False)

## API Endpoints

- **POST `/valuelist-strategy/analyze`** — Trigger census+classification+dedup (background job). Input: strategy. Returns: job_id.
- **GET `/valuelist-strategy/job/{job_id}`** — Poll job status + summary stats.
- **GET `/valuelist-strategy/profiles`** — Paginated list of TargetAttributeProfile rows with filtering.
- **GET `/valuelist-strategy/profiles/{attribute_id}`** — Detail: full values, item breakdown, dedup group.
- **GET `/valuelist-strategy/dedup-groups`** — Grouped view: which attributes share identical value sets.
- **POST `/valuelist-strategy/merge-preview`** — Preview superset merge with threshold. Returns proposed merges + noise cost.
- **POST `/valuelist-strategy/apply`** — Commit: create ValueList rows, update profiles and merged mappings.

## Frontend: New "Valuelist Strategy" Panel in Migration Manifest

- Summary bar: "X attributes: Y fixed-only, Z valuelist (W unique after dedup)"
- Attribute table: classification, item count, value count (green=fixed, blue=shared valuelist, yellow=unique valuelist)
- Dedup groups: expandable sections showing attributes sharing a valuelist
- Merge suggestions: cards with noise trade-off for optional superset merges
- Apply button: commits strategy

## Integration with Existing Flow

Fits after save-to-workspace (step 3 in current flow):
1. FeatureCombination analysis (existing)
2. ConsolidationPlan merge (existing)
3. Save to workspace → MergedWorkspaceMapping (existing)
4. **Valuelist Strategy analysis** (new)
5. **Review + optional merge** (new)
6. **Apply strategy** (new)
7. Generate Job respects valuelist_id for export

## Example

| Attribute | Items | Values per item | Classification | Valuelist |
|-----------|-------|-----------------|----------------|-----------|
| COLOR | 100 | 85×{Red}, 10×{Red,Blue}, 5×{Red,Blue,Green} | VALUELIST | {Red,Blue,Green} — 85 items marked effective_fixed |
| MATERIAL | 50 | All have {Steel} | FIXED_ONLY | None needed |
| SIZE | 30 | Various {S,M,L} | VALUELIST | {S,M,L} |
| WIDTH | 20 | Various {S,M,L} | VALUELIST | **Same as SIZE** → shared valuelist (dedup) |

Result: 2 valuelists instead of 4. MATERIAL needs 0. SIZE and WIDTH share 1.

## Relevant Files
- `backend/app/db/models.py` — New models + alter MergedWorkspaceMapping
- `backend/app/api/state.py` — New endpoints
- `backend/backend/alembic/versions/` — New migration
- `components/MigrationManifest.tsx` — New panel
- `services/dbService.ts` — API client
- `types.ts` — TypeScript interfaces

## Verification
1. Test: classify attributes (fixed_only vs valuelist) correctly
2. Test: dedup produces correct shared valuelist_ids
3. Test: superset merge preview calculates noise correctly
4. Integration: full pipeline → ValueList rows created, mappings updated
5. Manual: UI shows strategy panel with correct counts
6. Edge: 0 values after noise removal → fixed_only
7. Edge: single item → all fixed_only
