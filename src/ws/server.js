import { WebSocket, WebSocketServer } from "ws";
import { wsArcjet } from "../arcjet.js";

const matchSubscribers = new Map();

/* -------------------------
   SUBSCRIPTION MANAGEMENT
-------------------------- */

function subscribe(matchId, socket) {
  const id = Number(matchId);

  if (!matchSubscribers.has(id)) {
    matchSubscribers.set(id, new Set());
  }

  matchSubscribers.get(id).add(socket);
}

function unsubscribe(matchId, socket) {
  const id = Number(matchId);

  const subscribers = matchSubscribers.get(id);

  if (!subscribers) return;

  subscribers.delete(socket);

  if (subscribers.size === 0) {
    matchSubscribers.delete(id);
  }
}

function cleanupSubscriptions(socket) {
  for (const matchId of socket.subscriptions) {
    unsubscribe(matchId, socket);
  }
}

/* -------------------------
   HELPERS
-------------------------- */

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify(payload));
  }
}

function broadcastToMatch(matchId, payload) {
  const id = Number(matchId);

  const subscribers = matchSubscribers.get(id);

  console.log(
    "[WS] broadcastToMatch",
    id,
    "subscribers:",
    subscribers?.size ?? 0
  );

  if (!subscribers || subscribers.size === 0) return;

  const message = JSON.stringify(payload);

  for (const client of subscribers) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/* -------------------------
   MESSAGE HANDLER
-------------------------- */

function handleMessage(socket, data) {
  let message;

  try {
    message = JSON.parse(data.toString());
  } catch {
    sendJson(socket, { type: "error", message: "Invalid JSON" });
    return;
  }

  console.log("[WS RECEIVED]", message);

  // SUBSCRIBE
  if (message?.type === "subscribe") {
    const matchId = Number(message.matchId);

    if (!Number.isInteger(matchId)) return;

    subscribe(matchId, socket);
    socket.subscriptions.add(matchId);

    sendJson(socket, {
      type: "subscribed",
      matchId,
    });

    return;
  }

  // UNSUBSCRIBE
  if (message?.type === "unsubscribe") {
    const matchId = Number(message.matchId);

    if (!Number.isInteger(matchId)) return;

    unsubscribe(matchId, socket);
    socket.subscriptions.delete(matchId);

    sendJson(socket, {
      type: "unsubscribed",
      matchId,
    });
  }
}

/* -------------------------
   MAIN WS SERVER
-------------------------- */

export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
    maxPayload: 1024 * 1024,
  });

  server.on("upgrade", async (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    if (pathname !== "/ws") return;

    if (wsArcjet) {
      try {
        const decision = await wsArcjet.protect(req);

        if (decision.isDenied()) {
          socket.write(
            decision.reason.isRateLimit()
              ? "HTTP/1.1 429 Too Many Requests\r\n\r\n"
              : "HTTP/1.1 403 Forbidden\r\n\r\n"
          );
          socket.destroy();
          return;
        }
      } catch (e) {
        console.error("WS upgrade protection error", e);
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.subscriptions = new Set();

    socket.on("pong", () => (socket.isAlive = true));

    sendJson(socket, { type: "welcome" });

    socket.on("message", (data) => {
      handleMessage(socket, data);
    });

    socket.on("close", () => {
      cleanupSubscriptions(socket);
    });

    socket.on("error", (err) => {
      console.error("[WS ERROR]", err);
      socket.terminate();
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  /* -------------------------
     BROADCASTERS
  -------------------------- */

  function broadcastMatchCreated(match) {
    broadcastToAll(wss, { type: "match_created", data: match });
  }

  function broadcastCommentary(matchId, comment) {
    broadcastToMatch(matchId, { type: "commentary", data: comment });
  }

  function broadcastScoreUpdate(matchId, score) {
    broadcastToMatch(matchId, {
      type: "score_update",
      matchId: Number(matchId),
      data: score,
    });
  }

  return {
    broadcastMatchCreated,
    broadcastCommentary,
    broadcastScoreUpdate,
  };
}