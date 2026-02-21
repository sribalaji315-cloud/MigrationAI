
import { GlobalMapping, DatabaseState, User, ConnectionMode } from '../types';

const DB_KEYS = {
  STATE: 'erp_migrator_shared_state',
};

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

  async fetchAll(): Promise<{ state: DatabaseState; mode: ConnectionMode }> {
    const mode = await this.getConnectionMode();
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      try {
        const response = await fetch(`${SQL_ENDPOINT}/state`, { headers: this._authHeaders() });
        if (response.ok) {
          const state = await response.json();
          // classifications are now stored in a dedicated table
          try {
            const clsResp = await fetch(`${SQL_ENDPOINT}/classifications`, { headers: this._authHeaders() });
            if (clsResp.ok) {
              state.classifications = await clsResp.json();
            }
          } catch {}
          return { state, mode: 'REMOTE_SQL' };
        }
      } catch (e) {
        console.warn("SQL Fetch failed, falling back to local storage", e);
      }
    }

    // Fallback logic (Local/Mock)
    const raw = localStorage.getItem(DB_KEYS.STATE);
    if (!raw) {
      const initialState: DatabaseState = {
        bom: [],
        mappings: [],
        classifications: [],
        localMappings: {},
        itemClassifications: {},
        locks: {},
        users: [DEFAULT_ADMIN]
      };
      localStorage.setItem(DB_KEYS.STATE, JSON.stringify(initialState));
      return { state: initialState, mode: 'LOCAL_MOCK' };
    }
    
    const state = JSON.parse(raw);
    if (!state.users) state.users = [DEFAULT_ADMIN];
    return { state, mode: 'LOCAL_MOCK' };
  },

  async saveAll(data: DatabaseState): Promise<ConnectionMode> {
    const mode = await this.getConnectionMode();
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      try {
        const response = await fetch(`${SQL_ENDPOINT}/sync`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          // backend expects a wrapper { state: { ... } }
          body: JSON.stringify({ state: data })
        });
        // after syncing the generic state, push classification list separately
        if (response.ok) {
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
              return 'REMOTE_SQL';
            }
            console.log('Classifications saved successfully');
          } catch (err) {
            console.error('failed to sync classifications', err);
            alert(`Error saving classifications: ${err}`);
          }
          return 'REMOTE_SQL';
        } else {
          const errText = await response.text();
          console.error("SQL Sync failed:", response.status, errText);
          alert(`Sync failed: ${errText}`);
        }
      } catch (e) {
        console.error("SQL Sync failed", e);
        alert(`Network error: ${e}`);
      }
    }

    // Always save locally as a backup/primary storage for Mock mode
    localStorage.setItem(DB_KEYS.STATE, JSON.stringify(data));
    return 'LOCAL_MOCK';
  },

  async acquireLock(itemId: string, userId: string, userName: string): Promise<boolean> {
    const { state, mode } = await this.fetchAll();
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      try {
        const response = await fetch(`${SQL_ENDPOINT}/lock`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, userId, userName, action: 'acquire' })
        });
        if (response.ok) return true;
      } catch (e) {
        console.warn("SQL Lock failed, using local locking logic", e);
      }
    }

    // Local locking logic
    const existingLock = state.locks[itemId];
    if (existingLock && Date.now() - existingLock.timestamp > 1800000) {
      delete state.locks[itemId];
    }

    if (!state.locks[itemId] || state.locks[itemId].userId === userId) {
      state.locks[itemId] = { itemId, userId, userName, timestamp: Date.now() };
      await this.saveAll(state);
      return true;
    }
    return false;
  },

  async releaseLock(itemId: string, userId: string) {
    const { state, mode } = await this.fetchAll();

    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      try {
        await fetch(`${SQL_ENDPOINT}/lock`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, userId, action: 'release' })
        });
      } catch (e) {
        console.error("SQL Lock release failed", e);
      }
    }

    if (state.locks[itemId]?.userId === userId) {
      delete state.locks[itemId];
      await this.saveAll(state);
    }
  },

  async forceReleaseLock(itemId: string) {
    const { state, mode } = await this.fetchAll();
    
    if (mode === 'REMOTE_SQL' && SQL_ENDPOINT) {
      try {
        await fetch(`${SQL_ENDPOINT}/lock`, {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, action: 'force-release' })
        });
      } catch {}
    }

    delete state.locks[itemId];
    await this.saveAll(state);
  },

  async resetToDefaults() {
    localStorage.removeItem(DB_KEYS.STATE);
    // In SQL mode, typically a reset would be a specific admin endpoint
     if (SQL_ENDPOINT) {
       try { await fetch(`${SQL_ENDPOINT}/reset`, { method: 'POST', headers: this._authHeaders() }); } catch {}
     }
    return (await this.fetchAll()).state;
  }
};
