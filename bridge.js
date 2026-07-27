import express from 'express';
import { createServer } from 'https';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Generate or load self-signed HTTPS certificate ---
function getHttpsConfig() {
  const certPath = path.join(__dirname, 'cert.pem');
  const keyPath = path.join(__dirname, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  }

  console.log('[HTTPS] Generating self-signed certificate (takes 1-2 seconds)...');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  // Add SAN (Subject Alternative Names) for all local IPs so browsers don't reject the cert
  const localIPs = getLocalIPs();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIPs.map(ip => ({ type: 7, ip }))
  ];

  const pems = selfsigned.generate(attrs, { days: 365, extensions: [{ name: 'subjectAltName', altNames }] });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  return {
    key: pems.private,
    cert: pems.cert
  };
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const app = express();
const httpsOptions = getHttpsConfig();
const httpServer = createServer(httpsOptions, app);
const wss = new WebSocketServer({ noServer: true });

// Fix: Handle HTTPS server-level errors (e.g., EADDRINUSE) gracefully
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[BRIDGE] ERROR: Port ${PORT} is already in use. Is another bridge.js already running? Kill it or set PORT=<other>.`);
  } else {
    console.error('[BRIDGE] Server error:', err.message);
  }
  process.exit(1);
});

// Fix: Use path relative to file, not CWD
app.use(express.static(path.join(__dirname, 'public')));

// --- Active connections ---
let phoneSocket = null;
const mcpSockets = new Set();
// requestMap: msgId -> mcpSocket (which MCP client to route the response back to)
const requestMap = new Map();

// --- WebSocket routing: /mcp -> MCP clients, everything else -> phone ---
httpServer.on('upgrade', (request, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(request.url, `https://${request.headers.host}`).pathname;
  } catch (e) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === '/mcp') {
      handleMcpConnection(ws);
    } else {
      handlePhoneConnection(ws);
    }
  });
});

// --- Phone WebSocket Handler ---
function handlePhoneConnection(ws) {
  console.log('[BRIDGE] Phone connected');

  // If there was a previous phone socket, terminate it and clean up its pending requests
  if (phoneSocket) {
    // Reject any pending requests that were waiting for the old phone
    for (const [id, mcpSocket] of requestMap.entries()) {
      if (mcpSocket && mcpSocket.readyState === 1) {
        mcpSocket.send(JSON.stringify({
          id,
          error: "iOS client reconnected, previous session terminated."
        }));
      }
      requestMap.delete(id);
    }
    phoneSocket.terminate();
  }
  phoneSocket = ws;

  // Fix: Notify MCP clients that phone has connected (correctly checking readyState)
  mcpSockets.forEach(mcp => {
    if (mcp.readyState === 1) {
      mcp.send(JSON.stringify({ type: 'status', phoneConnected: true }));
    }
  });

  // Fix: Add error handler to prevent unhandled 'error' event crash
  ws.on('error', (err) => {
    console.error('[BRIDGE] Phone socket error:', err.message);
  });

  ws.on('message', (message) => {
    try {
      const response = JSON.parse(message);
      if (response && response.id) {
        const mcpSocket = requestMap.get(response.id);
        if (mcpSocket && mcpSocket.readyState === 1) {
          mcpSocket.send(JSON.stringify(response));
          requestMap.delete(response.id);
        } else {
          // MCP client disconnected before response arrived; clean up
          requestMap.delete(response.id);
        }
      }
    } catch (err) {
      console.error('[BRIDGE] Error parsing phone message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[BRIDGE] Phone disconnected');
    if (phoneSocket === ws) {
      phoneSocket = null;
      // Notify all MCP clients that phone disconnected
      mcpSockets.forEach(mcp => {
        if (mcp.readyState === 1) {
          mcp.send(JSON.stringify({ type: 'status', phoneConnected: false }));
        }
      });
    }
  });
}

// --- MCP Client WebSocket Handler ---
function handleMcpConnection(ws) {
  console.log('[BRIDGE] Local MCP Client connected');
  mcpSockets.add(ws);

  // Fix: Accurately report phone status based on readyState, not just reference existence
  ws.send(JSON.stringify({
    type: 'status',
    phoneConnected: !!(phoneSocket && phoneSocket.readyState === 1)
  }));

  // Fix: Add error handler to prevent unhandled 'error' event crash
  ws.on('error', (err) => {
    console.error('[BRIDGE] MCP socket error:', err.message);
  });

  ws.on('message', (message) => {
    try {
      const request = JSON.parse(message);
      if (request && request.id) {
        if (!phoneSocket || phoneSocket.readyState !== 1) {
          ws.send(JSON.stringify({
            id: request.id,
            error: "No iOS client connected. Please open the bridge webpage on your iPhone Safari first."
          }));
          return;
        }

        requestMap.set(request.id, ws);
        phoneSocket.send(JSON.stringify(request));
      }
    } catch (err) {
      console.error('[BRIDGE] Error parsing MCP message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[BRIDGE] Local MCP Client disconnected');
    mcpSockets.delete(ws);
    // Clean up any pending requests from this MCP client
    for (const [id, socket] of requestMap.entries()) {
      if (socket === ws) {
        requestMap.delete(id);
      }
    }
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\n======================================================`);
  console.log(`[BRIDGE] Hub Server listening on HTTPS port ${PORT}`);
  console.log(`[BRIDGE] Open this URL in Safari on your iPhone:`);
  ips.forEach(ip => {
    console.log(`   👉 https://${ip}:${PORT}`);
  });
  console.log(`======================================================\n`);
});
