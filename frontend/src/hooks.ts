import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * Keeps `path` fresh. The server pings over a WebSocket whenever anything changes (instant),
 * and we also poll every few seconds as a safety net so a flaky connection never freezes the UI.
 */
export function useLive<T>(path: string, lectureId: string, intervalMs = 2500) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    refetch();
    const poll = setInterval(refetch, intervalMs);
    let ws: WebSocket | null = null;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/${lectureId}`);
      ws.onmessage = () => refetch();
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(poll);
      ws?.close();
    };
  }, [path, lectureId, intervalMs, refetch]);

  return { data, error, refetch };
}
