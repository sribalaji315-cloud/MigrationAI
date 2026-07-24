# Backend API Reference

This file documents the backend HTTP API implemented under `backend/app`.

- Scope: HTTP routes only
- Included: `backend/app/main.py` and `backend/app/api/*.py`
- Excluded: WebSocket routes such as `/ws/{client_id}`
- Total HTTP routes documented here: 115

## Conventions

- `none` means the route does not take a JSON body.
- `query` means the route uses query-string parameters instead of a JSON body.
- `multipart` means the route expects a file upload.
- Response examples are representative and intentionally concise.
- Several list and analytics endpoints return large endpoint-specific objects; for those, this file shows the main shape rather than every field.

## Reusable JSON Shapes

### UserCreate

```json
{
	"username": "alice@example.com",
	"password": "secret",
	"role": "user"
}
```

### Token

```json
{
	"access_token": "jwt",
	"token_type": "bearer",
	"refresh_token": "jwt"
}
```

### UserOut

```json
{
	"id": 1,
	"username": "alice@example.com",
	"role": "admin",
	"approval_status": "approved"
}
```

### UserUpdate

```json
{
	"role": "user",
	"approval_status": "approved"
}
```

### Attribute

```json
{
	"attributeId": "COLOR",
	"description": "Color",
	"unit": null,
	"allowedValues": ["Red", "Blue"],
	"valueDescriptions": {
		"Red": "Red finish",
		"Blue": "Blue finish"
	}
}
```

### ClassificationCreate / ClassificationOut

```json
{
	"id": 1,
	"classId": "CLASS-100",
	"className": "Fastener",
	"attributes": [
		{
			"attributeId": "COLOR",
			"description": "Color",
			"unit": null,
			"allowedValues": ["Red", "Blue"],
			"valueDescriptions": {
				"Red": "Red finish"
			}
		}
	]
}
```

### ClassAttributeOut

```json
{
	"classId": "CLASS-100",
	"className": "Fastener",
	"attributeId": "COLOR",
	"description": "Color",
	"unit": null,
	"allowedValues": ["Red", "Blue"],
	"valueDescriptions": {
		"Red": "Red finish"
	}
}
```

### ValueListRowCreate / ValueListRowOut

```json
{
	"id": 1,
	"valuelistId": "VL-COLOR",
	"valuelistIdDescription": "Color list",
	"unit": null,
	"value": "Red",
	"valueDescription": "Red finish"
}
```

### MLSettingsIn

```json
{
	"useSynonymAssist": true,
	"synonymThreshold": 0.8,
	"synonymWeight": 0.35
}
```

### PredictResponse

```json
{
	"itemId": "ITEM-100",
	"predictions": [
		{
			"classId": "CLASS-100",
			"className": "Fastener",
			"confidence": 0.97
		}
	]
}
```

### PredictAllStatusResponse / Generic Job Status

```json
{
	"status": "running",
	"progress": 0.42,
	"total": 1200,
	"processed": 504,
	"error": null
}
```

### AssignClassificationRequest

```json
{
	"classId": "CLASS-100"
}
```

### StateIn

```json
{
	"state": {
		"example": true
	}
}
```

### ClassAttributeValuesIn

```json
{
	"classId": "CLASS-100",
	"previousClassId": "CLASS-090",
	"values": {
		"COLOR": "Red",
		"LENGTH": "10"
	}
}
```

### Generic OK Response

```json
{
	"ok": true
}
```

### Generic Paged Response

```json
{
	"items": [],
	"total": 0
}
```

### Generic Filter Response

```json
{
	"options": []
}
```

## Main

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| GET | / | `root` | none | JSON: `{"ok": true}` |

## Auth

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| POST | /auth/register | `register` | JSON `UserCreate` | JSON `UserOut` |
| POST | /auth/login | `login` | form-data `username`, `password` | JSON `Token` |
| POST | /auth/logout | `logout` | none, bearer token header | JSON `{"ok": true}` |
| POST | /auth/refresh | `refresh_token` | JSON `{"refresh_token": "jwt"}` | JSON `Token` |
| GET | /auth/me | `me` | none, bearer token header | JSON `UserOut` |
| GET | /auth/users | `get_users` | none, admin auth | JSON `UserOut[]` |
| PUT | /auth/users/{user_id} | `update_user` | JSON `UserUpdate` | JSON `UserOut` |
| DELETE | /auth/users/{user_id} | `delete_user` | none, admin auth | JSON confirmation or error detail |

## Classifications

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| GET | /classifications | `list_classifications` | none | JSON `ClassificationOut[]` |
| GET | /classifications/{class_id}/attributes/{attribute_id} | `get_class_attribute` | none | JSON `ClassAttributeOut` |
| POST | /classifications | `create_classification` | JSON `ClassificationCreate` | JSON `ClassificationOut` |
| POST | /classifications/bulk | `bulk_replace_classifications` | JSON `ClassificationCreate[]` | JSON `{"ok": true}` |

## Value Lists

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| GET | /valuelists/paginated | `list_valuelists_paginated` | query `search`, `limit`, `offset` | JSON `{"items": [...], "total": 0}` |
| GET | /valuelists/filters | `get_valuelist_filters` | query `valuelistId`, `value` | JSON `{"valuelists": [...], "values": [...]}` |
| GET | /valuelists/{valuelist_id} | `get_valuelist_detail` | none | JSON `ValueListRowOut[]` |
| POST | /valuelists/bulk | `bulk_replace_valuelists` | JSON `ValueListRowCreate[]` | JSON `{"ok": true, "rowsInserted": 10}` |
| POST | /valuelists/upload-csv | `upload_valuelist_csv` | multipart `file` | JSON `{"ok": true, "rowsInserted": 10}` |
| DELETE | /valuelists/{valuelist_id} | `delete_valuelist` | none, admin auth | JSON `{"ok": true, "rowsDeleted": 10}` |

## ML

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| GET | /ml/settings | `get_ml_settings` | none | JSON `MLSettingsIn` |
| PUT | /ml/settings | `update_ml_settings` | JSON `MLSettingsIn` | JSON `MLSettingsIn` |
| POST | /ml/predict/{item_id} | `predict_single` | none | JSON `PredictResponse` |
| POST | /ml/predict-all | `predict_all` | none | JSON `PredictAllStatusResponse` |
| GET | /ml/predict-all/status | `predict_all_status` | none | JSON `PredictAllStatusResponse` |
| PUT | /ml/classify/{item_id} | `assign_classification` | JSON `AssignClassificationRequest` | JSON `{"ok": true, "itemId": "ITEM-100", "classification": "CLASS-100"}` |

## State

| Method | Path | Function | Request | Response |
| --- | --- | --- | --- | --- |
| POST | /feature-combinations/trigger | `trigger_feature_combination_build` | none | JSON queued-job payload |
| GET | /feature-combinations/progress | `get_feature_combination_progress` | none | JSON job status |
| GET | /feature-combinations/filters | `get_feature_combination_filters` | query filters | JSON filter options |
| GET | /feature-combinations/list | `list_feature_combinations` | query search and paging filters | JSON paged list |
| GET | /feature-combinations/{combo_id}/items | `get_feature_combination_items` | none | JSON `{"items": [...]}` |
| GET | /feature-combinations/analysis-variants | `get_feature_variants` | query `featureId` and related filters | JSON variants summary |
| GET | /feature-combinations/analysis-cross-features | `get_cross_feature_matches` | query `featureId` and related filters | JSON cross-feature analysis |
| GET | /feature-combinations/analysis/{feature_id:path} | `get_feature_consolidation_analysis` | none | JSON analysis document |
| POST | /feature-combinations/consolidation-plans/compute | `trigger_consolidation_compute` | JSON feature selection payload | JSON queued-job payload |
| GET | /feature-combinations/consolidation-plans/by-feature | `get_consolidation_plan_by_feature` | query `featureId` | JSON plan detail |
| GET | /feature-combinations/consolidation-plans | `list_consolidation_plans` | query filters | JSON paged plans |
| GET | /health | `health` | none | JSON health payload |
| POST | /mapping-generation/trigger | `trigger_mapping_generation` | none | JSON queued-job payload |
| GET | /mapping-generation/progress | `get_mapping_generation_progress` | none | JSON job status |
| GET | /workspace-mappings/{item_id} | `get_workspace_mappings_for_item` | none | JSON item workspace mappings |
| POST | /workspace-mappings/{item_id}/revert-to-global | `revert_item_to_global` | none | JSON `{"ok": true}` |
| POST | /workspace-mappings/{item_id}/regenerate | `regenerate_item` | none | JSON `{"ok": true, "rowsDeleted": n, "rowsGenerated": n}` |
| POST | /workspace-mappings/revert-all-to-global | `revert_all_to_global` | JSON optional filter payload | JSON bulk result |
| PUT | /workspace-mappings/{item_id} | `put_workspace_mappings_for_item` | JSON mapping payload | JSON updated mappings |
| GET | /state | `get_state` | query filters and paging | JSON application state snapshot |
| GET | /bom/filters | `get_bom_filters` | query active filters | JSON filter options |
| GET | /bom/count | `get_bom_count` | query active filters | JSON `{"count": 0}` |
| GET | /init | `get_init` | none | JSON bootstrap payload |
| GET | /bom/signed-on | `get_bom_signed_on` | query filters | JSON sign-on summary |
| GET | /bom/items | `get_bom_items` | query filters and paging | JSON paged BOM items |
| POST | /bom/items/by-ids | `get_bom_items_by_ids` | JSON `{"itemIds": ["ITEM-1", "ITEM-2"]}` | JSON `{"items": [...]}` |
| POST | /sync | `sync_state` | JSON `StateIn` | JSON synced state result |
| POST | /lock | `handle_lock` | JSON lock payload | JSON lock status |
| GET | /dashboard/metrics | `get_dashboard_metrics` | query filters | JSON dashboard metrics |
| GET | /item-statuses | `get_item_statuses` | query item filters | JSON status summary |
| GET | /export/bom-csv | `export_bom_csv` | query export filters | CSV download |
| GET | /export/classifications-csv | `export_classifications_csv` | none | CSV download |
| GET | /export/valuelists-csv | `export_valuelists_csv` | none | CSV download |
| POST | /wipe-bom | `wipe_bom` | none | JSON `{"ok": true}` |
| POST | /attribute-options | `attribute_options` | JSON attribute lookup payload | JSON attribute options |
| POST | /global-mappings/by-features | `global_mappings_by_features` | JSON `{"featureIds": ["F1", "F2"]}` | JSON grouped mappings |
| GET | /global-mappings | `list_global_mappings` | query `search`, `limit`, `offset` | JSON paged mappings |
| GET | /bom/hierarchy | `get_bom_hierarchy` | query `limit`, `offset` | JSON hierarchy nodes |
| POST | /bom/hierarchy | `save_bom_hierarchy` | JSON hierarchy payload | JSON save result |
| GET | /bom/hierarchy/search | `search_bom_hierarchy_items` | query search text | JSON matching hierarchy items |
| GET | /bom/hierarchy/roots | `get_bom_hierarchy_roots` | query paging filters | JSON root nodes |
| GET | /bom/hierarchy/children/{parent_id} | `get_bom_hierarchy_children` | none | JSON child nodes |
| DELETE | /bom/hierarchy | `wipe_bom_hierarchy` | none | JSON `{"ok": true}` |
| POST | /global-mappings/upsert | `upsert_global_mapping` | JSON mapping payload | JSON upserted mapping |
| POST | /global-mappings/deduplicate | `deduplicate_global_mappings` | JSON dedupe options | JSON dedupe result |
| DELETE | /global-mappings/{mapping_id} | `delete_global_mapping` | none | JSON `{"ok": true}` |
| GET | /classifications/paginated | `list_classifications_paginated` | query search and paging | JSON paged list |
| GET | /classifications/filters | `get_classification_filters` | query active filters | JSON filter options |
| GET | /classifications/search | `search_classification_names` | query search text | JSON `{"items": [...]}` |
| GET | /classifications/{class_id} | `get_classification_by_id` | none | JSON classification detail |
| GET | /items/{item_id}/class-attribute-values | `get_class_attribute_values` | none | JSON item attribute values |
| PUT | /items/{item_id}/class-attribute-values | `put_class_attribute_values` | JSON `ClassAttributeValuesIn` | JSON updated values |
| DELETE | /items/{item_id}/class-attribute-values | `delete_class_attribute_values` | query or JSON identifying attributes to remove | JSON delete result |
| POST | /reset | `reset` | none | JSON reset result |
| POST | /attribute-combinations/trigger | `trigger_attribute_combination_build` | none | JSON queued-job payload |
| GET | /attribute-combinations/progress | `get_attribute_combination_progress` | none | JSON job status |
| GET | /attribute-combinations/filters | `get_attribute_combination_filters` | query filters | JSON filter options |
| GET | /attribute-combinations/list | `list_attribute_combinations` | query search and paging filters | JSON paged list |
| GET | /attribute-combinations/analysis/{combo_id} | `get_attribute_combination_analysis` | none | JSON combination analysis |
| GET | /attribute-combinations/{combo_id}/items | `get_attribute_combination_items` | none | JSON `{"items": [...]}` |
| GET | /migration-manifest/ready | `check_migration_manifest_ready` | none | JSON readiness summary |
| GET | /migration-manifest/filters | `get_migration_manifest_filters` | query active filters | JSON filter options |
| GET | /migration-manifest/item-summaries | `list_migration_manifest_item_summaries` | query search and paging | JSON paged item summaries |
| GET | /migration-manifest/items/{item_id}/attributes | `get_migration_manifest_item_attributes` | none | JSON manifest attribute rows |
| GET | /migration-manifest/items/{item_id}/attributes/{target_attribute_id}/values | `get_migration_manifest_value_merge_detail` | none | JSON merged value detail |
| POST | /migration-manifest/save-to-workspace | `save_manifest_to_workspace` | JSON manifest selection payload | JSON save result |
| GET | /merged-workspace-mappings/{item_id} | `get_merged_workspace_mappings` | none | JSON merged mappings |
| GET | /merged-workspace-mappings/{item_id}/detail | `get_merged_workspace_mappings_detail` | none | JSON merged mapping detail |
| GET | /merged-workspace-mappings-summary | `get_merged_workspace_mappings_summary` | query filters and paging | JSON summary list |
| POST | /merge-job/trigger | `trigger_merge_batch_job` | JSON merge job payload | JSON queued-job payload |
| GET | /merge-job/progress | `get_merge_job_progress` | none | JSON job status |
| POST | /valuelist-strategy/analyze | `valuelist_strategy_analyze` | JSON analysis payload | JSON `{"jobId": "...", "status": "queued"}` |
| GET | /valuelist-strategy/job/{job_id} | `valuelist_strategy_job_status` | none | JSON job detail |
| GET | /valuelist-strategy/profiles | `valuelist_strategy_profiles` | query filters and paging | JSON profile list |
| GET | /valuelist-strategy/profiles/{attribute_id} | `valuelist_strategy_profile_detail` | none | JSON profile detail |
| GET | /valuelist-strategy/dedup-groups | `valuelist_strategy_dedup_groups` | query filters | JSON dedup groups |
| POST | /valuelist-strategy/merge-preview | `valuelist_strategy_merge_preview` | JSON preview payload | JSON merge preview |
| POST | /valuelist-strategy/apply | `valuelist_strategy_apply` | JSON apply payload | JSON apply result |
| POST | /group-features/upload | `upload_group_features` | multipart file upload | JSON import result |
| POST | /group-features/apply-mappings | `trigger_group_feature_mapping` | JSON mapping job payload | JSON queued-job payload |
| GET | /group-features/mapping-progress | `get_group_feature_mapping_progress` | none | JSON job status |
| GET | /group-features/list | `list_group_features` | query search, filters, paging | JSON paged list |
| GET | /group-features/filters | `get_group_feature_filters` | query active filters | JSON filter options |
| GET | /group-features/stats | `get_group_feature_stats` | query active filters | JSON statistics summary |
| GET | /group-features/by-group/{group_name:path} | `get_group_feature_detail` | none | JSON group feature detail |
| GET | /group-features/where-used/{group_name:path} | `get_group_feature_where_used` | none | JSON usage list |
| GET | /group-features/export-csv | `export_group_features_csv` | query export filters | CSV download |
| POST | /group-features/update-status | `update_group_feature_status` | JSON status update payload | JSON update result |
| POST | /group-features/generate-valuelist | `generate_group_feature_valuelist` | JSON generation payload | JSON generated value-list result |
| POST | /group-features/suggest | `trigger_group_feature_suggest` | JSON suggestion job payload | JSON queued-job payload |
| GET | /group-features/suggest-progress | `get_group_feature_suggest_progress` | none | JSON job status |

## Notes

- Many state endpoints are analytics or export endpoints backed by large dynamic payloads; this reference intentionally captures the stable contract shape, not every nested field.
- Authentication-sensitive endpoints generally require a bearer token and, for destructive updates, often require an admin user.
- CSV export routes return file content instead of JSON.
