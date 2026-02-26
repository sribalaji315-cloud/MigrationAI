
import { GlobalMapping, DatabaseState, User, ConnectionMode, NewAttribute } from '../types';

// Backend API endpoint: in production use Vite env `VITE_SQL_API_ENDPOINT`,
// otherwise fall back to local FastAPI for development.
const SQL_ENDPOINT = import.meta.env.VITE_SQL_API_ENDPOINT || 'http://localhost:8000';

const DEFAULT_ADMIN: User = {
  userId: 'USR-ADMIN',
  userName: 'Admin_Master',
  password: 'admin_password',
  role: 'admin'
};

const TOKEN_KEY = 'erp_migrator_token';

export const dbService = {
  async getConnectionMode(): Promise<ConnectionMode> {
    if (!SQL_ENDPOINT) return 'LOCAL_MOCK';
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000); // 2s timeout for SQL probe
      const headers = this._authHeaders();
      const response = await fetch(`${SQL_ENDPOINT}/health`, { signal: controller.signal, headers });
      clearTimeout(id);
      return response.ok ? 'REMOTE_SQL' : 'LOCAL_MOCK';
    } catch {
      return 'LOCAL_MOCK';
    }
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
    return data;
  },

  async me() {
    const resp = await fetch(`${SQL_ENDPOINT}/auth/me`, { headers: this._authHeaders() });
    if (!resp.ok) throw new Error('Failed to retrieve current user');
    return resp.json();
  },

  async fetchAll(options?: { includeBom?: boolean }): Promise<{ state: DatabaseState; mode: ConnectionMode }> {
    const mode = await this.getConnectionMode();
    const includeBom = options?.includeBom ?? true;
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      const response = await fetch(`${SQL_ENDPOINT}/state?include_bom=${includeBom ? 'true' : 'false'}`, { headers: this._authHeaders() });
      if (!response.ok) {
        throw new Error(`Failed to fetch state from database: ${response.status}`);
      }
      
      const state = await response.json();
      
      // classifications are now stored in a dedicated table
      try {
        const clsResp = await fetch(`${SQL_ENDPOINT}/classifications`, { headers: this._authHeaders() });
        if (clsResp.ok) {
          state.classifications = await clsResp.json();
        }
      } catch (e) {
        console.warn("Failed to fetch classifications, using empty array", e);
      }
      
      return { state, mode: 'REMOTE_SQL' };
    }

    throw new Error('Database connection not available. Please ensure backend is running.');
  },

  async fetchClassificationAttribute(classId: string, attributeId: string): Promise<NewAttribute> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const urlClass = encodeURIComponent(classId);
    const urlAttr = encodeURIComponent(attributeId);
    const resp = await fetch(`${SQL_ENDPOINT}/classifications/${urlClass}/attributes/${urlAttr}`, {
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

  async fetchBomFilters(options?: { category?: string; productType?: string }): Promise<{ categories: string[]; productTypes: string[] }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.productType) params.set('productType', options.productType);
    const query = params.toString();
    const resp = await fetch(`${SQL_ENDPOINT}/bom/filters${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch BOM filters: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async fetchBomItemsByIds(itemIds: string[]): Promise<DatabaseState['bom']> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    if (!itemIds.length) return [];
    const resp = await fetch(`${SQL_ENDPOINT}/bom/items/by-ids`, {
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

  async fetchBomItems(category?: string, productType?: string): Promise<DatabaseState['bom']> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available.');
    }
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (productType) params.set('productType', productType);
    const query = params.toString();
    const resp = await fetch(`${SQL_ENDPOINT}/bom/items${query ? `?${query}` : ''}`, { headers: this._authHeaders() });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to fetch BOM items: ${resp.status} ${errText}`);
    }
    return resp.json();
  },

  async saveAll(data: DatabaseState, userRole: 'admin' | 'user' | undefined = 'user'): Promise<ConnectionMode> {
    const mode = await this.getConnectionMode();
    
    if (mode !== 'REMOTE_SQL' || !SQL_ENDPOINT) {
      throw new Error('Database connection not available. Cannot save data.');
    }

    const response = await fetch(`${SQL_ENDPOINT}/sync`, {
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

    // After syncing the generic state, push classification list separately
    // but only when the current user is an administrator. Non-admin users
    // should still be able to save BOM and mappings without hitting the
    // admin-only classifications endpoint.
    if (userRole === 'admin') {
      try {
        console.log('Sending classifications to bulk endpoint:', data.classifications);
        const clsResp = await fetch(`${SQL_ENDPOINT}/classifications/bulk`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(data.classifications || [])
        });
        
        if (clsResp.status === 403) {
          alert('Only administrators are allowed to modify shared classifications.');
          return 'REMOTE_SQL';
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
    
    return 'REMOTE_SQL';
  },

  async acquireLock(itemId: string, userId: string, userName: string): Promise<{ acquired: boolean; reason?: string }> {
    if (!SQL_ENDPOINT) {
      throw new Error('Database connection not available');
    }

    try {
      const response = await fetch(`${SQL_ENDPOINT}/lock`, {
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
      const response = await fetch(`${SQL_ENDPOINT}/lock`, {
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
      const response = await fetch(`${SQL_ENDPOINT}/lock`, {
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

    await fetch(`${SQL_ENDPOINT}/reset`, { 
      method: 'POST', 
      headers: this._authHeaders() 
    });
    
    return (await this.fetchAll()).state;
  }
};