"""
WebSocket connection manager for real-time collaboration.
Broadcasts lock changes, mapping updates, and generation progress to connected clients.
Uses FastAPI's built-in WebSocket support — no additional packages required.
"""

import asyncio
import json
import logging
import time
from typing import Dict, Set, Optional

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("erp_migrator")


class ConnectionManager:
    """Manages WebSocket connections and broadcasts events to all connected clients."""

    def __init__(self):
        self._connections: Dict[str, WebSocket] = {}  # keyed by user_id or connection_id
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        async with self._lock:
            self._connections[client_id] = websocket
        logger.info("ws_connect client=%s total=%d", client_id, len(self._connections))

    async def disconnect(self, client_id: str):
        async with self._lock:
            self._connections.pop(client_id, None)
        logger.info("ws_disconnect client=%s total=%d", client_id, len(self._connections))

    async def broadcast(self, event_type: str, payload: dict, exclude: Optional[str] = None):
        """Send an event to all connected clients, optionally excluding one."""
        message = json.dumps({"type": event_type, "payload": payload, "ts": time.time()})
        async with self._lock:
            targets = list(self._connections.items())

        stale: list[str] = []
        for client_id, ws in targets:
            if client_id == exclude:
                continue
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(client_id)

        if stale:
            async with self._lock:
                for cid in stale:
                    self._connections.pop(cid, None)

    async def send_to(self, client_id: str, event_type: str, payload: dict):
        """Send an event to a specific client."""
        async with self._lock:
            ws = self._connections.get(client_id)
        if ws:
            try:
                message = json.dumps({"type": event_type, "payload": payload, "ts": time.time()})
                await ws.send_text(message)
            except Exception:
                async with self._lock:
                    self._connections.pop(client_id, None)

    @property
    def active_count(self) -> int:
        return len(self._connections)


# Singleton instance
manager = ConnectionManager()


# --- Event broadcasting helpers (call from API endpoints) ---

async def broadcast_lock_change(item_id: str, lock_info: Optional[dict], actor_id: Optional[str] = None):
    """Notify all clients that a lock was acquired or released."""
    await manager.broadcast("lock_change", {"itemId": item_id, "lock": lock_info}, exclude=actor_id)


async def broadcast_mapping_update(item_id: str, actor_id: Optional[str] = None):
    """Notify clients that mappings changed for an item."""
    await manager.broadcast("mapping_update", {"itemId": item_id}, exclude=actor_id)


async def broadcast_generation_progress(progress: dict):
    """Broadcast mapping generation progress to all clients."""
    await manager.broadcast("generation_progress", progress)


async def broadcast_sync(actor_id: Optional[str] = None):
    """Notify clients that a bulk data sync occurred (BOM upload, etc.)."""
    await manager.broadcast("data_sync", {}, exclude=actor_id)
