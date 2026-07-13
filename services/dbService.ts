
import { GlobalMapping, DatabaseState, User, ConnectionMode, NewAttribute, WorkspaceMappingRow, MappingGenerationProgress, ValueListGroup, ValueListRow, NewClassification, BomHierarchyItem, MLPrediction, MLSettings, FeatureCombinationJobProgress, FeatureCombinationRow, FeatureCombinationItem, ConsolidationAnalysis, SubsetMergeDetail, AttributeCombinationJobProgress, AttributeCombinationRow, AttributeCombinationItem, AttrComboConsolidationAnalysis, MigrationManifestRow, MigrationManifestFilters, MigrationManifestItemSummary, MigrationManifestAttributeGroup, MigrationManifestValueDetail, MergedWorkspaceMappingRow, MergeJob, ValuelistStrategyJob, TargetAttributeProfile, ValuelistDedupGroup, ValuelistMergeProposal, ValuelistApplyResult, GroupFeatureRow, GroupFeatureMappingJobProgress, GroupFeatureWhereUsedItem, GroupFeatureFilters, ApplyGroupFeatureProgress, ItemApprovalState } from '../types';

export interface SaveAllResult {
  mode: ConnectionMode;
  mappingGenerationJobId?: number | null;
  mappingsReceived?: number;
  globalMappingsInserted?: number;
  globalMappingsTotal?: number;
}

export interface DashboardItemMetrics {
  itemId: string;
  description: string;
  category: string;
  productType: string;
  totalFeatures: number;
  mappedFeatures: number;
  notRequiredFeatures: number;
  excludedFeatures: number;
  totalValues: number;
  mappedValues: number;
  excludedValues: number;
  fullyMapped: boolean;
}

export interface DashboardMetricsResponse {
  totals: { items: number; features: number; values: number };
  mapped: { features: number; values: number; items: number; notRequiredFeatures: number };
  excluded: { features: number; values: number };
  coverage: { attribute: number; value: number; item: number };
  approval?: { approved: number; unapproved: number };
  includeExcluded: boolean;
  items: DashboardItemMetrics[];
}

function resolveSqlEndpoint() {
  const configuredEndpoint = (import.meta as any).env?.VITE_SQL_API_ENDPOINT;
  if (configuredEndpoint) {
    return configuredEndpoint;
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:8000`;
  }

  return 'http://localhost:8000';
}

const SQL_ENDPOINT = resolveSqlEndpoint();
const MODE_CACHE_TTL_MS = 15000;

const DEFAULT_ADMIN: User = {
  userId: 'USR-ADMIN',
  userName: 'Admin_Master',
  password: 'admin_password',
  role: 'admin'
};

const TOKEN_KEY = 'erp_migrator_token';
const REFRESH_TOKEN_KEY = 'erp_migrator_refresh_token';

export const dbService = {
  _modeCache: null as ConnectionMode | null,
  _modeCacheExpiresAt: 0,
  _modePromise: null as Promise<ConnectionMode> | null,
  _refreshPromise: null as Promise<boolean> | null,

  // --- Request caching & deduplication ---
  _cache: new Map<string, { data: any; expiresAt: number }>(),
  _inflight: new Map<string, Promise<any>>(),

  async _cachedFetch(url: string, options?: RequestInit & { _ttlMs?: number; _timeoutMs?: number }): Promise<any> {
    const ttlMs = options?._ttlMs ?? 30000;
    const timeoutMs = options?._timeoutMs ?? 15000;
    const cacheKey = `${options?.method || 'GET'}:${url}`;
    const now = Date.now();

    // Return cached data if still valid
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    // Deduplicate in-flight requests
    const inflight = this._inflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('Request timed out'), timeoutMs);

    const promise = (async () => {
      try {
        const { _ttlMs: _, _timeoutMs: _t, ...fetchOpts } = options || {} as any;
        const resp = await this._fetchWithRefresh(url, { ...fetchOpts, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`${resp.status} ${errText}`);
        }
        const data = await resp.json();
        this._cache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
        return data;
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw err;
      } finally {
        this._inflight.delete(cacheKey);
      }
    })();

    this._inflight.set(cacheKey, promise);
    return promise;
  },

  /** Invalidate all cached GET responses (call after mutations). */
  _invalidateCache() {
    this._cache.clear();
  },

  async getConnectionMode(): Promise<ConnectionMode> {
    if (!SQL_ENDPOINT) return 'LOCAL_MOCK';
    const now = Date.now();
    if (this._modeCache && this._modeCacheExpiresAt > now) {
      return this._modeCache;
    }
    if (this._modePromise) {
      return this._modePromise;
    }

    this._modePromise = (async () => {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000); // 2s timeout for SQL probe
        const headers = this._authHeaders();
        const response = await fetch(`${SQL_ENDPOINT}/health`, { signal: controller.signal, headers });
        clearTimeout(id);
        const mode: ConnectionMode = response.ok ? 'REMOTE_SQL' : 'LOCAL_MOCK';
        this._modeCache = mode;
        this._modeCacheExpiresAt = Date.now() + MODE_CACHE_TTL_MS;
        return mode;
      } catch {
        this._modeCache = 'LOCAL_MOCK';
        this._modeCacheExpiresAt = Date.now() + MODE_CACHE_TTL_MS;
        return 'LOCAL_MOCK';
      } finally {
        this._modePromise = null;
      }
    })();

    return this._modePromise;
  },

  _authHeaders(): Record<string,string> {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  },

  async register(username: string, password: string, role = 'user') {
    const resp = await fetch(`${SQL_ENDPOINT}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(JSON.parse(errorText)?.detail || 'Registration failed');
    }
    return resp.json();
  },

  async updateUser(userId: number, data: { role?: string; approval_status?: string }) {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/auth/users/${userId}`, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to update user: ${resp.status} ${err}`);
    }
    return resp.json();
  },

  async deleteUser(userId: number) {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/auth/users/${userId}`, {
      method: 'DELETE',
      headers: this._authHeaders()
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to delete user: ${resp.status} ${err}`);
    }
    return resp.json();
  },

  async login(username: string, password: string) {
    // backend expects form-urlencoded OAuth2 password grant
    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', password);
    const resp = await fetch(`${SQL_ENDPOINT}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!resp.ok) throw new Error('Login failed');
    const data = await resp.json();
    if (data?.access_token) localStorage.setItem(TOKEN_KEY, data.access_token);
    if (data?.refresh_token) localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    return data;
  },

  async refreshAccessToken(): Promise<boolean> {
    if (this._refreshPromise) return this._refreshPromise;
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) return false;
    this._refreshPromise = (async () => {
      try {
        const resp = await fetch(`${SQL_ENDPOINT}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!resp.ok) {
          localStorage.removeItem(REFRESH_TOKEN_KEY);
          return false;
        }
        const data = await resp.json();
        if (data?.access_token) localStorage.setItem(TOKEN_KEY, data.access_token);
        if (data?.refresh_token) localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
        return true;
      } catch {
        return false;
      }
    })();
    return this._refreshPromise.finally(() => { this._refreshPromise = null; });
  },

  async _fetchWithRefresh(url: string, init?: RequestInit): Promise<Response> {
    let resp = await fetch(url, init);
    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        // Retry with new token
        const newInit = { ...init, headers: { ...((init?.headers as Record<string,string>) || {}), ...this._authHeaders() } };
        resp = await fetch(url, newInit);
      }
    }
    return resp;
  },

  async me() {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/auth/me`, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error('Failed to retrieve current user');
    return resp.json();
  },

  async fetchAll(options?: { includeBom?: boolean }): Promise<{ state: DatabaseState; mode: ConnectionMode }> {
    const mode = await this.getConnectionMode();
    const includeBom = options?.includeBom ?? true;
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      const response = await this._fetchWithRefresh(`${SQL_ENDPOINT}/state?include_bom=${includeBom ? 'true' : 'false'}`, { headers: this._authHeaders() });
      if (!response.ok) {
        throw new Error(`Failed to fetch state from database: ${response.status}`);
      }
      
      const state = await response.json();
      
      return { state, mode: 'REMOTE_SQL' };
    }

    throw new Error('Database connection not available. Please ensure backend is running.');
  },

  async fetchInit(): Promise<{
    locks: Record<string, import('../types').ItemLock>;
    users: import('../types').User[];
    mappingTypeConfig?: import('../types').MappingTypeConfig;
    itemClassifications: Record<string, string>;
  }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/init`, { headers: this._authHeaders() });
    if (!resp.ok) {
      throw new Error(`Failed to fetch init: ${resp.status}`);
    }
    return resp.json();
  },

  async fetchSignedOnBomItems(options?: {
    category?: string;
    productType?: string;
    userId?: string;
    search?: string;
    priority?: number;
    unmappedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: DatabaseState['bom']; signedOnCount: number; totalCount: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.productType) params.set('productType', options.productType);
    if (options?.userId) params.set('userId', options.userId);
    if (options?.search) params.set('search', options.search);
    if (options?.priority != null) params.set('priority', String(options.priority));
    if (options?.unmappedOnly) params.set('unmappedOnly', 'true');
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/bom/signed-on${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  async fetchClassificationAttribute(classId: string, attributeId: string): Promise<NewAttribute> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const urlClass = encodeURIComponent(classId);
    const urlAttr = encodeURIComponent(attributeId);
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/classifications/${urlClass}/attributes/${urlAttr}`, {
      headers: this._authHeaders()
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch attribute: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    return {
      attributeId: data.attributeId,
      description: data.description,
      allowedValues: data.allowedValues || [],
      valueDescriptions: data.valueDescriptions || {},
      unit: data.unit || '',
    };
  },

  async fetchBomFilters(options?: { category?: string; productType?: string; priority?: number }): Promise<{ categories: string[]; productTypes: string[]; priorities: number[] }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.productType) params.set('productType', options.productType);
    if (options?.priority != null) params.set('priority', String(options.priority));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/bom/filters${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async fetchBomItemsByIds(itemIds: string[]): Promise<DatabaseState['bom']> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    if (!itemIds.length) return [];
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/bom/items/by-ids`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(itemIds),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch BOM items by ids: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchBomItems(category?: string, productType?: string, options?: { limit?: number; offset?: number; search?: string; priority?: number; unmappedOnly?: boolean }): Promise<DatabaseState['bom']> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (productType) params.set('productType', productType);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.search) params.set('search', options.search);
    if (options?.priority != null) params.set('priority', String(options.priority));
    if (options?.unmappedOnly) params.set('unmappedOnly', 'true');
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/bom/items${query ? `?${query}` : ''}`, { headers: this._authHeaders(), _ttlMs: 15000 });
  },

  async fetchBomCount(category?: string, productType?: string, search?: string, priority?: number, unmappedOnly?: boolean, excludeOtherLocks?: boolean): Promise<number> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (productType) params.set('productType', productType);
    if (search) params.set('search', search);
    if (priority != null) params.set('priority', String(priority));
    if (unmappedOnly) params.set('unmappedOnly', 'true');
    if (excludeOtherLocks) params.set('excludeOtherLocks', 'true');
    const query = params.toString();
    const data = await this._cachedFetch(`${SQL_ENDPOINT}/bom/count${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    return data?.total ?? 0;
  },

  async fetchGlobalMappingsPaginated(options?: { limit?: number; offset?: number; search?: string }): Promise<{ items: GlobalMapping[]; total: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    if (options?.search) params.set('search', options.search);
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/global-mappings${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async fetchGlobalMappingsByFeatures(featureIds: string[]): Promise<Record<string, GlobalMapping[]>> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/global-mappings/by-features`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureIds }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch global mappings by features: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchAttributeOptions(featureId: string, classId?: string | null, search?: string): Promise<{ globalCandidates: string[]; classAttributes: string[]; warningIds: string[] }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const body: Record<string, string> = { featureId };
    if (classId) body.classId = classId;
    if (search) body.search = search;
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/attribute-options`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch attribute options: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async upsertGlobalMapping(record: GlobalMapping): Promise<{ ok: boolean; item: GlobalMapping; globalMappingsTotal: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/global-mappings/upsert`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save global mapping: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async deleteGlobalMapping(id: number): Promise<{ ok: boolean; deletedId: number; globalMappingsTotal: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/global-mappings/${id}`, {
      method: 'DELETE',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to delete global mapping: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchClassificationsPaginated(options?: { limit?: number; offset?: number; search?: string }): Promise<{ items: NewClassification[]; total: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    if (options?.search) params.set('search', options.search);
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/classifications/paginated${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async fetchClassificationFilters(options?: { classId?: string; attributeId?: string }): Promise<{ classes: { classId: string; className: string }[]; attributes: string[] }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.classId) params.set('classId', options.classId);
    if (options?.attributeId) params.set('attributeId', options.attributeId);
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/classifications/filters${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async searchClassificationNames(search?: string, limit = 20): Promise<{ items: { classId: string; className: string }[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('limit', String(limit));
    const query = params.toString();
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/classifications/search?${query}`, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error(`Classification search failed: ${resp.status}`);
    return resp.json();
  },

  async fetchClassification(classId: string): Promise<NewClassification> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/classifications/${encodeURIComponent(classId)}`, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error(`Failed to fetch classification '${classId}': ${resp.status}`);
    return resp.json();
  },

  async fetchWorkspaceMappings(itemId: string): Promise<WorkspaceMappingRow[]> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/workspace-mappings/${encodeURIComponent(itemId)}`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch workspace mappings: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async saveWorkspaceMappings(itemId: string, rows: WorkspaceMappingRow[]): Promise<{ ok: boolean; rowsSaved: number }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/workspace-mappings/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save workspace mappings: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchItemApprovalState(itemId: string): Promise<ItemApprovalState> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/bom/items/${encodeURIComponent(itemId)}/approval-state`,
      { headers: this._authHeaders() },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch approval state: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async setFeatureApproval(itemId: string, featureId: string, approved: boolean): Promise<ItemApprovalState> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/workspace-mappings/${encodeURIComponent(itemId)}/feature-approval`,
      {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId, approved }),
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to set feature approval: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async setItemApproval(itemId: string, approved: boolean): Promise<ItemApprovalState> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/bom/items/${encodeURIComponent(itemId)}/approval`,
      {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to set item approval: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async revertItemToGlobal(itemId: string): Promise<{ ok: boolean; rowsDeleted: number; rowsGenerated: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/workspace-mappings/${encodeURIComponent(itemId)}/revert-to-global`,
      { method: 'POST', headers: this._authHeaders() },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to revert to global: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async revertAllToGlobal(): Promise<{ ok: boolean; localRowsDeleted: number; mappingGenerationJobId: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/workspace-mappings/revert-all-to-global`,
      { method: 'POST', headers: this._authHeaders() },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to revert all to global: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchMappingGenerationProgress(): Promise<MappingGenerationProgress> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/mapping-generation/progress`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch mapping generation progress: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async triggerMappingGeneration(): Promise<{ ok: boolean; mappingGenerationJobId: number | null }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/mapping-generation/trigger`, {
      method: 'POST',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger mapping generation: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async triggerApplyGroupFeatures(): Promise<{ ok: boolean; jobId: number | null }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/workspace-mappings/apply-group-features`, {
      method: 'POST',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger apply group features: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchApplyGroupFeatureProgress(): Promise<ApplyGroupFeatureProgress> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/workspace-mappings/apply-group-features/progress`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch apply group feature progress: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchDashboardMetrics(options?: { category?: string; productLine?: string; priority?: number; includeExcluded?: boolean; forceRecompute?: boolean }): Promise<DashboardMetricsResponse> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.productLine) params.set('productLine', options.productLine);
    if (options?.priority != null) params.set('priority', String(options.priority));
    if (options?.includeExcluded) params.set('includeExcluded', 'true');
    if (options?.forceRecompute) params.set('forceRecompute', 'true');
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/dashboard/metrics${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
      _timeoutMs: 120000,
      _ttlMs: 0,
    });
  },

  async fetchItemStatuses(itemIds?: string[]): Promise<Record<string, 'mapped' | 'unmapped' | 'notRequired'>> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    let url = `${SQL_ENDPOINT}/item-statuses`;
    if (itemIds && itemIds.length > 0) {
      url += `?itemIds=${encodeURIComponent(itemIds.join(','))}`;
    }
    const data = await this._cachedFetch(url, {
      headers: this._authHeaders(),
      _ttlMs: 0,
    });
    return data?.statuses || {};
  },

  async logout(): Promise<void> {
    if (!SQL_ENDPOINT) return;
    try {
      await fetch(`${SQL_ENDPOINT}/auth/logout`, {
        method: 'POST',
        headers: this._authHeaders(),
      });
    } catch {
      // Best-effort; token removal happens client-side regardless
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    this._invalidateCache();
  },

  async exportBomCsv(filters?: { category?: string; productType?: string; search?: string }): Promise<Blob> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (filters?.category) params.set('category', filters.category);
    if (filters?.productType) params.set('productType', filters.productType);
    if (filters?.search) params.set('search', filters.search);
    const query = params.toString();
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/export/bom-csv${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to export BOM CSV: ${resp.status} ${errText}`);
    }
    return resp.blob();
  },

  async exportClassificationsCsv(filters?: { search?: string; classId?: string }): Promise<Blob> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (filters?.search) params.set('search', filters.search);
    if (filters?.classId) params.set('classId', filters.classId);
    const query = params.toString();
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/export/classifications-csv${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to export classifications CSV: ${resp.status} ${errText}`);
    }
    return resp.blob();
  },

  async exportValuelistsCsv(filters?: { search?: string; valuelistId?: string }): Promise<Blob> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (filters?.search) params.set('search', filters.search);
    if (filters?.valuelistId) params.set('valuelistId', filters.valuelistId);
    const query = params.toString();
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/export/valuelists-csv${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to export valuelists CSV: ${resp.status} ${errText}`);
    }
    return resp.blob();
  },

  async wipeBom(): Promise<void> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/wipe-bom`, { method: 'POST', headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to wipe BOM data: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
  },

  async importSwingFeasibility(dryRun = false): Promise<{ ok: boolean; dryRun: boolean; sourceDbPath: string; summary: string }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/imports/swing-feasibility?dryRun=${dryRun ? 'true' : 'false'}`, {
      method: 'POST',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to import swing feasibility data: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async uploadSwingExpansionXlsx(
    itemFile: File,
    groupFile: File,
    dryRun = false,
  ): Promise<{ ok: boolean; status: string; dryRun: boolean }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const formData = new FormData();
    formData.append('item_file', itemFile);
    formData.append('group_file', groupFile);
    const headers: Record<string, string> = {};
    const auth = this._authHeaders();
    if (auth.Authorization) headers.Authorization = auth.Authorization;
    const resp = await this._fetchWithRefresh(
      `${SQL_ENDPOINT}/imports/swing-expansion?dryRun=${dryRun ? 'true' : 'false'}`,
      {
        method: 'POST',
        headers,
        body: formData,
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to start swing expansion import: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchSwingExpansionProgress(): Promise<{
    status: string;
    isActive: boolean;
    phase: string | null;
    progress: number;
    totalItems: number;
    processedItems: number;
    stagedRows: number;
    matched: number;
    updated: number;
    counts: { Yes: number; No: number; Conditional: number; Review: number };
    parseFailures: number;
    dryRun: boolean;
    error: string | null;
  }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/imports/swing-expansion/progress`, {
      method: 'GET',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch swing expansion progress: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async saveAll(
    data: DatabaseState,
    userRole: 'admin' | 'user' | undefined = 'user',
    _options?: { includeBom?: boolean }
  ): Promise<SaveAllResult> {
    const mode = await this.getConnectionMode();
    
    if (mode !== 'REMOTE_SQL' || !SQL_ENDPOINT) {
      throw new Error('Database connection not available. Cannot save data.');
    }

    const response = await this._fetchWithRefresh(`${SQL_ENDPOINT}/sync`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      // backend expects a wrapper { state: { ... } }
      body: JSON.stringify({ state: data })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error("SQL Sync failed:", response.status, errText);
      throw new Error(`Failed to save to database: ${errText}`);
    }

    const syncResult = await response.json().catch(() => ({}));
    const mappingGenerationJobId = typeof syncResult?.mappingGenerationJobId === 'number'
      ? syncResult.mappingGenerationJobId
      : null;
    const mappingsReceived = typeof syncResult?.mappingsReceived === 'number'
      ? syncResult.mappingsReceived
      : undefined;
    const globalMappingsInserted = typeof syncResult?.globalMappingsInserted === 'number'
      ? syncResult.globalMappingsInserted
      : undefined;
    const globalMappingsTotal = typeof syncResult?.globalMappingsTotal === 'number'
      ? syncResult.globalMappingsTotal
      : undefined;

    // After syncing the generic state, push classification list separately
    // but only when the current user is an administrator AND classifications
    // were explicitly included in the payload (i.e. the caller is saving
    // classification data). When saving other categories (mapping, bom, etc.)
    // classifications are omitted from `data` to avoid overwriting the full
    // table with a partial page of 20 records.
    if (userRole === 'admin' && data.classifications !== undefined) {
      try {
        console.log('Sending classifications to bulk endpoint:', data.classifications);
        const clsResp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/classifications/bulk`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(data.classifications || [])
        });
        
        if (clsResp.status === 403) {
          alert('Only administrators are allowed to modify shared classifications.');
          return {
            mode: 'REMOTE_SQL',
            mappingGenerationJobId,
            mappingsReceived,
            globalMappingsInserted,
            globalMappingsTotal,
          };
        }
        
        if (!clsResp.ok) {
          const errText = await clsResp.text();
          console.error('Classifications bulk endpoint error:', clsResp.status, errText);
          alert(`Failed to save classifications: ${errText}`);
        } else {
          console.log('Classifications saved successfully');
        }
      } catch (err) {
        console.error('failed to sync classifications', err);
        alert(`Error saving classifications: ${err}`);
      }
    } else {
      console.log('Skipping classifications sync for non-admin user');
    }
    
    this._invalidateCache();
    return {
      mode: 'REMOTE_SQL',
      mappingGenerationJobId,
      mappingsReceived,
      globalMappingsInserted,
      globalMappingsTotal,
    };
  },

  async acquireLock(itemId: string, userId: string, userName: string): Promise<{ acquired: boolean; reason?: string }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available');
    }

    try {
      const response = await this._fetchWithRefresh(`${SQL_ENDPOINT}/lock`, {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userId, userName, action: 'acquire' })
      });
      if (!response.ok) {
        return { acquired: false, reason: 'error' };
      }
      const data = await response.json().catch(() => ({}));
      if (data && typeof data.acquired === 'boolean') {
        return { acquired: data.acquired, reason: data.reason };
      }
      return { acquired: response.ok };
    } catch (e) {
      console.error("Failed to acquire lock", e);
      return { acquired: false, reason: 'error' };
    }
  },

  async releaseLock(itemId: string, userId: string) {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available');
    }

    try {
      const response = await this._fetchWithRefresh(`${SQL_ENDPOINT}/lock`, {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userId, action: 'release' })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        console.error("Failed to release lock:", response.status, errText);
      } else {
        console.log("Lock released successfully for", itemId);
      }
    } catch (e) {
      console.error("Failed to release lock", e);
    }
  },

  async forceReleaseLock(itemId: string) {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available');
    }

    try {
      const response = await this._fetchWithRefresh(`${SQL_ENDPOINT}/lock`, {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userId: 'force', action: 'force-release' })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        console.error("Failed to force release lock:", response.status, errText);
      } else {
        console.log("Lock force-released successfully for", itemId);
      }
    } catch (e) {
      console.error("Failed to force release lock", e);
    }
  },

  async resetToDefaults(): Promise<DatabaseState> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available');
    }

    await this._fetchWithRefresh(`${SQL_ENDPOINT}/reset`, { 
      method: 'POST', 
      headers: this._authHeaders() 
    });
    
    return (await this.fetchAll()).state;
  },

  // ---------------------------------------------------------------------------
  // Value List endpoints
  // ---------------------------------------------------------------------------

  async fetchValueListsPaginated(options?: { limit?: number; offset?: number; search?: string }): Promise<{ items: ValueListGroup[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    if (options?.search) params.set('search', options.search);
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelists/paginated${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async fetchValueListDetail(valuelistId: string): Promise<ValueListRow[]> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelists/${encodeURIComponent(valuelistId)}`, { headers: this._authHeaders() });
  },

  async fetchValueListFilters(options?: { valuelistId?: string; value?: string }): Promise<{ valuelists: { valuelistId: string; valuelistIdDescription: string }[]; values: string[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.valuelistId) params.set('valuelistId', options.valuelistId);
    if (options?.value) params.set('value', options.value);
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelists/filters${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
  },

  async uploadValueListCsv(file: File): Promise<{ ok: boolean; rowsInserted: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    const auth = this._authHeaders();
    if (auth.Authorization) headers.Authorization = auth.Authorization;
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelists/upload-csv`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to upload CSV: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async deleteValueList(valuelistId: string): Promise<{ ok: boolean; rowsDeleted: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelists/${encodeURIComponent(valuelistId)}`, {
      method: 'DELETE',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to delete value list: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async saveValueListsBulk(rows: ValueListRow[]): Promise<{ ok: boolean; rowsInserted: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelists/bulk`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save value lists: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  // --- BOM Hierarchy ---

  async fetchBomHierarchy(limit = 500, offset = 0): Promise<{ items: BomHierarchyItem[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(
      `${SQL_ENDPOINT}/bom/hierarchy?limit=${limit}&offset=${offset}`,
      { headers: this._authHeaders(), _ttlMs: 15000 },
    );
  },

  async saveBomHierarchy(items: BomHierarchyItem[]): Promise<{ ok: boolean; rowsInserted: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/bom/hierarchy`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save BOM hierarchy: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async deleteBomHierarchy(): Promise<{ ok: boolean }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/bom/hierarchy`, {
      method: 'DELETE',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to delete BOM hierarchy: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchHierarchyRoots(): Promise<{ roots: string[]; allBomNodes: string[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(
      `${SQL_ENDPOINT}/bom/hierarchy/roots`,
      { headers: this._authHeaders(), _ttlMs: 15000 },
    );
  },

  async fetchHierarchyChildren(parentId: string): Promise<{ items: BomHierarchyItem[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(
      `${SQL_ENDPOINT}/bom/hierarchy/children/${encodeURIComponent(parentId)}`,
      { headers: this._authHeaders(), _ttlMs: 15000 },
    );
  },

  async searchBomHierarchyItems(query: string, limit = 30): Promise<{ items: { itemId: string; description: string }[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('limit', String(limit));
    const qs = params.toString();
    return this._cachedFetch(
      `${SQL_ENDPOINT}/bom/hierarchy/search${qs ? `?${qs}` : ''}`,
      { headers: this._authHeaders(), _ttlMs: 0 },
    );
  },

  // --- ML Classification ---

  async predictClassification(itemId: string): Promise<{ itemId: string; predictions: MLPrediction[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/ml/predict/${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`ML prediction failed: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async predictAllClassifications(): Promise<{ status: string; progress: number; total: number; processed: number; error?: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/ml/predict-all`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`ML predict-all failed: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async getPredictAllStatus(): Promise<{ status: string; progress: number; total: number; processed: number; error?: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/ml/predict-all/status`, { headers: this._authHeaders(), _ttlMs: 2000 });
  },

  async assignClassification(itemId: string, classId: string): Promise<{ ok: boolean; itemId: string; classification: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/ml/classify/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Classification assignment failed: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async getClassAttributeValues(itemId: string): Promise<{ classId: string | null; values: Record<string, string> }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/items/${encodeURIComponent(itemId)}/class-attribute-values`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch class attribute values: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async saveClassAttributeValues(
    itemId: string,
    classId: string,
    previousClassId: string | null,
    values: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/items/${encodeURIComponent(itemId)}/class-attribute-values`, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, previousClassId, values }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save class attribute values: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async deleteClassAttributeValues(itemId: string): Promise<{ ok: boolean; deleted: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/items/${encodeURIComponent(itemId)}/class-attribute-values`, {
      method: 'DELETE',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to delete class attribute values: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async getMLSettings(): Promise<MLSettings> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/ml/settings`, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error(`Failed to fetch ML settings: ${resp.status}`);
    return resp.json();
  },

  async updateMLSettings(patch: Partial<MLSettings>): Promise<MLSettings> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/ml/settings`, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) throw new Error(`Failed to update ML settings: ${resp.status}`);
    return resp.json();
  },

  // --- Feature Combinations ---

  async triggerFeatureCombinationBuild(): Promise<{ ok: boolean; jobId: number | null }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/feature-combinations/trigger`, {
      method: 'POST',
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger feature combination build: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchFeatureCombinationProgress(): Promise<FeatureCombinationJobProgress> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/feature-combinations/progress`, {
      headers: this._authHeaders(),
      _ttlMs: 0,
    });
  },

  async fetchFeatureCombinations(options?: { search?: string; featureId?: string; attributeType?: string; priority?: number; status?: string; footprint?: string; sortBy?: string; sortDir?: string; analysisMode?: boolean; limit?: number; offset?: number }): Promise<{ items: FeatureCombinationRow[]; total: number; valueListStats?: { sharedRows: number; uniqueRows: number; distinctShared: number; distinctUnique: number; totalDistinct: number } }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.search) params.set('search', options.search);
    if (options?.featureId) params.set('featureId', options.featureId);
    if (options?.attributeType) params.set('attributeType', options.attributeType);
    if (options?.priority != null) params.set('priority', String(options.priority));
    if (options?.status) params.set('status', options.status);
    if (options?.footprint) params.set('footprint', options.footprint);
    if (options?.sortBy) params.set('sortBy', options.sortBy);
    if (options?.sortDir) params.set('sortDir', options.sortDir);
    if (options?.analysisMode) params.set('analysisMode', 'true');
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/feature-combinations/list${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchFeatureCombinationFilters(): Promise<{ featureIds: string[]; attributeTypes: string[]; priorities: number[]; statuses: string[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/feature-combinations/filters`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  async fetchFeatureCombinationItems(comboId: number): Promise<{ items: FeatureCombinationItem[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/feature-combinations/${comboId}/items`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  async fetchConsolidationAnalysis(featureId: string): Promise<ConsolidationAnalysis> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/feature-combinations/analysis/${encodeURIComponent(featureId)}`, {
      headers: this._authHeaders(),
      _ttlMs: 15000,
    });
  },

  async fetchVariantComparison(featureId: string): Promise<import('../types').VariantComparisonResponse> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await fetch(`${SQL_ENDPOINT}/feature-combinations/analysis-variants?featureId=${encodeURIComponent(featureId)}`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch variant comparison: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchCrossFeatureMatches(featureId: string): Promise<import('../types').CrossFeatureResponse> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await fetch(`${SQL_ENDPOINT}/feature-combinations/analysis-cross-features?featureId=${encodeURIComponent(featureId)}`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch cross-feature matches: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async triggerConsolidationCompute(featureId: string, strategy: string): Promise<{ featureId: string; strategy: string; status: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await fetch(`${SQL_ENDPOINT}/feature-combinations/consolidation-plans/compute`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, strategy }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger consolidation: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchConsolidationPlan(featureId: string): Promise<SubsetMergeDetail> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await fetch(`${SQL_ENDPOINT}/feature-combinations/consolidation-plans/by-feature?featureId=${encodeURIComponent(featureId)}`, {
      headers: this._authHeaders(),
    });
    if (!resp.ok) {
      if (resp.status === 404) return null as any;
      const errText = await resp.text();
      throw new Error(`Failed to fetch consolidation plan: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async triggerAttributeCombinationBuild(attributeTypes?: string[]): Promise<{ ok: boolean; jobId: number | null }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/attribute-combinations/trigger`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributeTypes: attributeTypes && attributeTypes.length > 0 ? attributeTypes : undefined }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger attribute combination build: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchAttributeCombinationProgress(): Promise<AttributeCombinationJobProgress> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/attribute-combinations/progress`, {
      headers: this._authHeaders(),
    }, 3000);
  },

  async fetchAttributeCombinations(options?: { search?: string; category?: string; productType?: string; attributeType?: string; priority?: number; minFeatures?: number; maxFeatures?: number; sortBy?: string; sortDir?: string; analysisMode?: boolean; limit?: number; offset?: number }): Promise<{ items: AttributeCombinationRow[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.search) params.set('search', options.search);
    if (options?.category) params.set('category', options.category);
    if (options?.productType) params.set('productType', options.productType);
    if (options?.attributeType) params.set('attributeType', options.attributeType);
    if (options?.priority !== undefined) params.set('priority', String(options.priority));
    if (options?.minFeatures !== undefined) params.set('minFeatures', String(options.minFeatures));
    if (options?.maxFeatures !== undefined) params.set('maxFeatures', String(options.maxFeatures));
    if (options?.sortBy) params.set('sortBy', options.sortBy);
    if (options?.sortDir) params.set('sortDir', options.sortDir ?? 'desc');
    if (options?.analysisMode) params.set('analysisMode', 'true');
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/attribute-combinations/list${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
    }, 5000);
  },

  async fetchAttributeCombinationFilters(): Promise<{ categories: string[]; productTypes: string[]; priorities: number[]; attributeTypes: string[]; availableAttributeTypes: string[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/attribute-combinations/filters`, {
      headers: this._authHeaders(),
    }, 30000);
  },

  async fetchAttributeCombinationItems(comboId: number): Promise<{ items: AttributeCombinationItem[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/attribute-combinations/${comboId}/items`, {
      headers: this._authHeaders(),
    }, 5000);
  },

  async fetchAttrComboConsolidationAnalysis(comboId: number): Promise<AttrComboConsolidationAnalysis> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/attribute-combinations/analysis/${comboId}`, {
      headers: this._authHeaders(),
      _ttlMs: 15000,
    });
  },

  async checkMigrationManifestReady(): Promise<{ ready: boolean; attributeCombinations: number; featureCombinations: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/migration-manifest/ready`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  async fetchMigrationManifestFilters(): Promise<MigrationManifestFilters> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/migration-manifest/filters`, {
      headers: this._authHeaders(),
      _ttlMs: 30000,
    });
  },

  async fetchMigrationManifestItemSummaries(options?: { search?: string; category?: string; productType?: string; priority?: number; attributeType?: string; source?: string; hasNoise?: boolean; hasMapping?: boolean; itemIds?: string; sortBy?: string; sortDir?: string; limit?: number; offset?: number }): Promise<{ items: MigrationManifestItemSummary[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.search) params.set('search', options.search);
    if (options?.category) params.set('category', options.category);
    if (options?.productType) params.set('productType', options.productType);
    if (options?.priority !== undefined) params.set('priority', String(options.priority));
    if (options?.attributeType) params.set('attributeType', options.attributeType);
    if (options?.source) params.set('source', options.source);
    if (options?.hasNoise !== undefined) params.set('hasNoise', String(options.hasNoise));
    if (options?.hasMapping !== undefined) params.set('hasMapping', String(options.hasMapping));
    if (options?.itemIds) params.set('itemIds', options.itemIds);
    if (options?.sortBy) params.set('sortBy', options.sortBy);
    if (options?.sortDir) params.set('sortDir', options.sortDir ?? 'desc');
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/migration-manifest/item-summaries${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchMigrationManifestItemAttributes(itemId: string): Promise<{ attributes: MigrationManifestAttributeGroup[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/migration-manifest/items/${encodeURIComponent(itemId)}/attributes`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchMigrationManifestValueDetail(itemId: string, targetAttributeId: string): Promise<MigrationManifestValueDetail> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/migration-manifest/items/${encodeURIComponent(itemId)}/attributes/${encodeURIComponent(targetAttributeId)}/values`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async saveManifestToWorkspace(itemId: string, targetAttributeId: string, sources: Array<'attr_merge' | 'value_merge'>): Promise<{ ok: boolean; manifestRowsAccepted: number; mergedMappingsCreated: number; mergedMappingsUpdated: number; savedAt: number; savedBy?: string | null; sources: string[] }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/migration-manifest/save-to-workspace`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, targetAttributeId, sources }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to save manifest to workspace: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchMergedWorkspaceMappings(itemId: string): Promise<{ items: MergedWorkspaceMappingRow[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/merged-workspace-mappings/${encodeURIComponent(itemId)}`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchMergedWorkspaceMappingsDetail(itemId: string): Promise<import('../types').MergedWorkspaceMappingDetail> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/merged-workspace-mappings/${encodeURIComponent(itemId)}/detail`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchMergedWorkspaceMappingsSummary(): Promise<{ totalRows: number; distinctItems: number; metrics?: { emptyAttributeFootprints: number; uniqueAttributeFootprints: number; itemsWithCombo: number; maxComboSize: number; uniqueValueFootprints: number; emptyValueFootprintAttrs: number; itemsWithSharedVL: number; totalSharedVLAttrs: number }; footprintItems?: { category: string; productType: string; priority: string; hasAttrFp: boolean; attrFp: string; count: number }[]; filterOptions?: { categories: string[]; productTypes: string[]; priorities: string[] } }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/merged-workspace-mappings-summary`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  // ---------------------------------------------------------------------------
  // Merge Batch Job
  // ---------------------------------------------------------------------------

  async triggerMergeJob(): Promise<{ ok: boolean; jobId?: number; error?: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/merge-job/trigger`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
    });
    return resp.json();
  },

  async fetchMergeJobProgress(): Promise<MergeJob> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/merge-job/progress`, {
      headers: this._authHeaders(),
      _ttlMs: 2000,
    });
  },

  // ---------------------------------------------------------------------------
  // Valuelist Strategy
  // ---------------------------------------------------------------------------

  async triggerValuelistStrategyAnalysis(strategy: 'conservative' | 'aggressive' = 'conservative'): Promise<{ jobId: number; status: string }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelist-strategy/analyze`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to trigger valuelist analysis: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  async fetchValuelistStrategyJobStatus(jobId: number): Promise<ValuelistStrategyJob> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelist-strategy/job/${jobId}`, {
      headers: this._authHeaders(),
      _ttlMs: 2000,
    });
  },

  async fetchValuelistStrategyProfiles(options?: { classification?: string; search?: string; limit?: number; offset?: number }): Promise<{ items: TargetAttributeProfile[]; total: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const params = new URLSearchParams();
    if (options?.classification) params.set('classification', options.classification);
    if (options?.search) params.set('search', options.search);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const query = params.toString();
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelist-strategy/profiles${query ? `?${query}` : ''}`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchValuelistStrategyProfileDetail(attributeId: string): Promise<TargetAttributeProfile> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelist-strategy/profiles/${encodeURIComponent(attributeId)}`, {
      headers: this._authHeaders(),
      _ttlMs: 5000,
    });
  },

  async fetchValuelistStrategyDedupGroups(): Promise<{ groups: ValuelistDedupGroup[]; totalGroups: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    return this._cachedFetch(`${SQL_ENDPOINT}/valuelist-strategy/dedup-groups`, {
      headers: this._authHeaders(),
      _ttlMs: 10000,
    });
  },

  async fetchValuelistStrategyMergePreview(strategy: 'conservative' | 'aggressive' = 'conservative', threshold?: number): Promise<{ proposals: ValuelistMergeProposal[]; totalProposals: number; strategy: string; threshold: number }> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelist-strategy/merge-preview`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy, threshold: threshold ?? 0.8 }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch merge preview: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async applyValuelistStrategy(mergeOverrides?: Array<{ listA: string; listB: string; mergedValuelistId: string }>): Promise<ValuelistApplyResult> {
    if (!SQL_ENDPOINT) throw new Error('Database connection not available.');
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/valuelist-strategy/apply`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergeOverrides: mergeOverrides || [] }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to apply valuelist strategy: ${resp.status} ${errText}`);
    }
    this._invalidateCache();
    return resp.json();
  },

  // ---------- Group Features ----------

  async uploadGroupFeatures(rows: Record<string, string>[]): Promise<{ ok: boolean; rowsInserted: number }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/upload`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Upload group features failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async fetchGroupFeatures(params: { search?: string; featureGroup?: string; featureId?: string; valueStatus?: string; targetAttribute?: string; targetValue?: string; sortBy?: string; sortDir?: string; limit?: number; offset?: number }): Promise<{ items: GroupFeatureRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params.search) sp.set('search', params.search);
    if (params.featureGroup) sp.set('featureGroup', params.featureGroup);
    if (params.featureId) sp.set('featureId', params.featureId);
    if (params.valueStatus) sp.set('valueStatus', params.valueStatus);
    if (params.targetAttribute) sp.set('targetAttribute', params.targetAttribute);
    if (params.targetValue) sp.set('targetValue', params.targetValue);
    if (params.sortBy) sp.set('sortBy', params.sortBy);
    if (params.sortDir) sp.set('sortDir', params.sortDir);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/list?${sp.toString()}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async fetchGroupFeatureFilters(featureGroup?: string): Promise<GroupFeatureFilters> {
    const sp = new URLSearchParams();
    if (featureGroup) sp.set('featureGroup', featureGroup);
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/filters?${sp.toString()}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async fetchGroupFeatureStats(params: { search?: string; featureGroup?: string; featureId?: string; valueStatus?: string; targetAttribute?: string; targetValue?: string }): Promise<{ totalGroups: number; totalSubFeatures: number; totalValues: number; statusCounts: Record<string, number>; unmappedAttributes: number; totalWhereUsed: number }> {
    const sp = new URLSearchParams();
    if (params.search) sp.set('search', params.search);
    if (params.featureGroup) sp.set('featureGroup', params.featureGroup);
    if (params.featureId) sp.set('featureId', params.featureId);
    if (params.valueStatus) sp.set('valueStatus', params.valueStatus);
    if (params.targetAttribute) sp.set('targetAttribute', params.targetAttribute);
    if (params.targetValue) sp.set('targetValue', params.targetValue);
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/stats?${sp.toString()}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async triggerGroupFeatureMappingJob(): Promise<{ ok: boolean; jobId: number }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/apply-mappings`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Trigger mapping failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async fetchGroupFeatureMappingProgress(): Promise<GroupFeatureMappingJobProgress> {
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/mapping-progress`, { headers: this._authHeaders(), _ttlMs: 2_000 });
  },

  async fetchGroupFeatureWhereUsed(groupName: string): Promise<{ featureGroup: string; items: GroupFeatureWhereUsedItem[]; total: number }> {
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/where-used/${encodeURIComponent(groupName)}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async updateGroupFeatureStatus(ids: number[], valueStatus: string): Promise<{ ok: boolean; updated: number }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/update-status`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, valueStatus }),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Update status failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async bulkUpdateGroupFeatureTarget(ids: number[], updates: { targetAttribute?: string | null; targetValue?: string | null }): Promise<{ ok: boolean; updated: number }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/bulk-update-target`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, ...updates }),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Bulk update failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async updateGroupFeatureRow(id: number, updates: { targetAttribute?: string | null; targetValue?: string | null; valueStatus?: string; comments?: string | null }): Promise<{ ok: boolean; id: number; targetAttribute: string | null; targetValue: string | null; valueStatus: string; comments: string | null }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/update-row`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Update row failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async fetchGroupFeatureClassificationAttributes(search?: string, limit = 20): Promise<{ items: { attributeId: string; description: string; classCount: number }[] }> {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('limit', String(limit));
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/classification-attributes?${params}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async fetchGroupFeatureAttributeValues(attributeId: string, search?: string, limit = 20): Promise<{ items: { value: string; description: string }[] }> {
    const params = new URLSearchParams();
    params.set('attributeId', attributeId);
    if (search) params.set('search', search);
    params.set('limit', String(limit));
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/attribute-values?${params}`, { headers: this._authHeaders(), _ttlMs: 10_000 });
  },

  async generateGroupFeatureValuelist(featureGroup: string): Promise<{ ok: boolean; valuelistsCreated: number; valuelistRowsCreated: number; skippedFeatures: string[]; createdValuelistIds: string[] }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/generate-valuelist`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureGroup }),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Generate valuelist failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  exportGroupFeaturesCsvUrl(params: { search?: string; featureGroup?: string; featureId?: string; valueStatus?: string; targetAttribute?: string; targetValue?: string }): string {
    const qp = new URLSearchParams();
    if (params.search) qp.set('search', params.search);
    if (params.featureGroup) qp.set('featureGroup', params.featureGroup);
    if (params.featureId) qp.set('featureId', params.featureId);
    if (params.valueStatus) qp.set('valueStatus', params.valueStatus);
    if (params.targetAttribute) qp.set('targetAttribute', params.targetAttribute);
    if (params.targetValue) qp.set('targetValue', params.targetValue);
    return `${SQL_ENDPOINT}/group-features/export-csv?${qp.toString()}`;
  },

  async downloadGroupFeaturesCsv(params: { search?: string; featureGroup?: string; featureId?: string; valueStatus?: string; targetAttribute?: string; targetValue?: string }): Promise<void> {
    const url = this.exportGroupFeaturesCsvUrl(params);
    const resp = await this._fetchWithRefresh(url, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'group_features_export.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  },

  async triggerGroupFeatureSuggest(): Promise<{ ok: boolean; jobId: number }> {
    const resp = await this._fetchWithRefresh(`${SQL_ENDPOINT}/group-features/suggest`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`Trigger suggest failed: ${resp.status} ${t}`); }
    this._invalidateCache();
    return resp.json();
  },

  async fetchGroupFeatureSuggestProgress(): Promise<GroupFeatureMappingJobProgress> {
    return this._cachedFetch(`${SQL_ENDPOINT}/group-features/suggest-progress`, { headers: this._authHeaders(), _ttlMs: 2_000 });
  },
};