import { useEffect, useRef, useCallback } from 'react';

export interface WsEvent {
  type: 'lock_change' | 'mapping_update' | 'generation_progress' | 'data_sync' | 'approval_change' | 'ml_prediction_progress';
  payload: any;
  ts: number;
}

type WsEventHandler = (event: WsEvent) => void;

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30000;

function resolveHttpBase() {
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

export function useWebSocket(
  clientId: string | null,
  onEvent: WsEventHandler,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pingTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!clientId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const httpBase = resolveHttpBase();
    const host = new URL(httpBase).host;
    const url = `${protocol}//${host}/ws/${encodeURIComponent(clientId)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Start keepalive pings
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (event.data === 'pong') return;
      try {
        const parsed: WsEvent = JSON.parse(event.data);
        onEventRef.current(parsed);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      clearInterval(pingTimer.current);
      // Auto-reconnect
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [clientId]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [connect]);

  return wsRef;
}
