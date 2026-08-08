/**
 * EventSource-compatible channel that prefers WebSocket and falls back to SSE.
 * @typedef {{ data: string }} EventChannelMessageEvent
 * @typedef {(event: EventChannelMessageEvent) => void} EventChannelListener
 * @typedef {{
 *   onerror: ((event: Event|EventChannelMessageEvent) => void)|null,
 *   onopen: ((event: Event) => void)|null,
 *   addEventListener(type: string, fn: EventChannelListener): void,
 *   removeEventListener(type: string, fn: EventChannelListener): void,
 *   close(): void,
 * }} EventChannel
 */

/**
 * @param {string} url
 * @returns {EventChannel}
 */
export function openEventChannel(url) {
  /** @type {Map<string, Set<EventChannelListener>>} */
  const listeners = new Map();
  /** @type {WebSocket | EventSource | null} */
  let transport = null;
  /** @type {number | undefined} */
  let fallbackTimer;
  /** @type {number | undefined} */
  let reconnectTimer;
  let closed = false;
  let opened = false;
  let usingEventSource = false;

  /** @type {EventChannel} */
  const channel = {
    onerror: null,
    onopen: null,
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
      if (usingEventSource && transport instanceof EventSource) {
        transport.addEventListener(type, /** @type {EventListener} */ (/** @type {unknown} */ (fn)));
      }
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
      if (usingEventSource && transport instanceof EventSource) {
        transport.removeEventListener(type, /** @type {EventListener} */ (/** @type {unknown} */ (fn)));
      }
    },
    close() {
      closed = true;
      clearTimer("fallback");
      clearTimer("reconnect");
      if (transport) transport.close();
      transport = null;
    },
  };

  /** @param {"fallback"|"reconnect"} which */
  function clearTimer(which) {
    if (which === "fallback" && fallbackTimer !== undefined) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    } else if (which === "reconnect" && reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  /** @param {string} type @param {string} data */
  function dispatch(type, data) {
    const event = { data };
    for (const fn of listeners.get(type) ?? []) fn(event);
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimer("fallback");
    clearTimer("reconnect");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      openWebSocket();
    }, 2000);
  }

  function openEventSource() {
    if (closed) return;
    clearTimer("fallback");
    opened = false;
    usingEventSource = true;
    const source = new EventSource(url);
    transport = source;
    source.onopen = (event) => {
      opened = true;
      if (channel.onopen) channel.onopen(event);
    };
    source.onerror = (event) => {
      if (channel.onerror) channel.onerror(event);
    };
    for (const [type, set] of listeners) {
      for (const fn of set) source.addEventListener(type, /** @type {EventListener} */ (/** @type {unknown} */ (fn)));
    }
  }

  function openWebSocket() {
    if (closed) return;
    opened = false;
    usingEventSource = false;
    const wsUrl = `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}${url}`;
    const ws = new WebSocket(wsUrl);
    transport = ws;
    fallbackTimer = window.setTimeout(() => {
      if (closed || transport !== ws || ws.readyState === WebSocket.OPEN) return;
      ws.close();
      openEventSource();
    }, 1500);
    ws.onopen = (event) => {
      if (closed || transport !== ws) return;
      opened = true;
      clearTimer("fallback");
      if (channel.onopen) channel.onopen(event);
    };
    ws.onerror = () => {
      if (closed || transport !== ws) return;
      if (!opened) {
        ws.close();
        openEventSource();
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data);
        if (!payload || typeof payload !== "object") return;
        const type = typeof payload.event === "string" ? payload.event : "message";
        const data = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
        dispatch(type, data);
      } catch {
        // Ignore malformed bridge frames.
      }
    };
    ws.onclose = () => {
      if (closed || transport !== ws) return;
      clearTimer("fallback");
      if (opened) {
        if (channel.onerror) channel.onerror({ data: "" });
        scheduleReconnect();
      } else {
        openEventSource();
      }
    };
  }

  openWebSocket();
  return channel;
}
