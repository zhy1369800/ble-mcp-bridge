import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Constants ---
const PORT = process.env.PORT || 3000;
const BRIDGE_WS_URL = `wss://localhost:${PORT}/mcp`;

// Fix: Use relative path derived from current file location, not hardcoded user path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'server_debug.log');

// --- Debug Logger ---
function debugLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch(e) {}
}

// --- State ---
let phoneConnected = false;
let ws = null;
const pendingRequests = new Map();

// --- WebSocket Connection to Bridge Hub ---
function connectToBridge() {
  debugLog(`Connecting to bridge hub at ${BRIDGE_WS_URL}`);
  console.error(`[MCP] Connecting to bridge hub at ${BRIDGE_WS_URL}...`);
  
  ws = new WebSocket(BRIDGE_WS_URL, {
    rejectUnauthorized: false // Required for self-signed certificates
  });

  ws.on('open', () => {
    debugLog('WS Connection open');
    console.error('[MCP] Connected to bridge hub');
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      debugLog(`Received message: ${JSON.stringify(message)}`);
      
      if (message.type === 'status') {
        phoneConnected = !!message.phoneConnected;
        debugLog(`Updated phoneConnected = ${phoneConnected}`);
        console.error(`[MCP] Phone connection state updated: ${phoneConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
        return;
      }

      if (message && message.id) {
        const pending = pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.result);
          }
        }
      }
    } catch (err) {
      debugLog(`Error parsing message: ${err.message}`);
      console.error('[MCP] Failed to parse message from bridge:', err);
    }
  });

  ws.on('close', () => {
    phoneConnected = false;
    debugLog('WS Connection closed');
    console.error('[MCP] Connection to bridge lost. Reconnecting in 3 seconds...');
    for (const [id, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge connection lost."));
      pendingRequests.delete(id);
    }
    setTimeout(connectToBridge, 3000);
  });

  // Fix: Add error handler to prevent unhandled 'error' event crash
  ws.on('error', (err) => {
    debugLog(`WS Connection error: ${err.message}`);
    console.error('[MCP] Connection error:', err.message);
    // 'close' event will fire after 'error', reconnect logic is there
  });
}

connectToBridge();

// --- Wait for phone to be connected (up to timeoutMs ms) ---
function waitConnected(timeoutMs = 2000) {
  debugLog(`waitConnected called. ws: ${ws?.readyState}, phoneConnected: ${phoneConnected}`);
  return new Promise((resolve) => {
    if (ws && ws.readyState === 1 && phoneConnected) {
      debugLog('waitConnected: already connected');
      return resolve(true);
    }
    
    const start = Date.now();
    const interval = setInterval(() => {
      if (ws && ws.readyState === 1 && phoneConnected) {
        clearInterval(interval);
        debugLog(`waitConnected resolved after ${Date.now() - start}ms`);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        debugLog(`waitConnected timed out. phoneConnected: ${phoneConnected}`);
        resolve(false);
      }
    }, 50);
  });
}

// --- Send a command to the phone via the bridge and wait for response ---
async function sendToolRequest(method, params, timeoutMs = 30000) {
  await waitConnected(2000);

  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      return reject(new Error("MCP client is not connected to the local bridge hub. Please make sure 'npm start' (bridge.js) is running in your terminal."));
    }

    if (!phoneConnected) {
      return reject(new Error("No iOS client connected to the bridge. Please open the bridge webpage on your iPhone Safari first."));
    }

    const id = uuidv4();
    const request = { id, method, params };

    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Command '${method}' timed out after ${timeoutMs / 1000}s. Did the user approve the scan on the phone?`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify(request));
  });
}

// --- MCP Server Setup ---
const mcpServer = new Server(
  { name: "ble-mcp-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_bridge_status",
        description: "Get the status of the iPhone bridge connection. Call this first to check if everything is ready.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "scan_ble_devices",
        description: "Scan for Bluetooth LE devices near the iPhone. Filters by service UUIDs if provided. This will trigger a user approval modal on the iPhone before the native BLE device picker appears. The user must select a device from the list.",
        inputSchema: {
          type: "object",
          properties: {
            services: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of service UUIDs (e.g. ['heart_rate', '180d']) to filter device picker AND to declare as optionalServices for later access. If empty, shows all devices but NO characteristics can be read/written afterwards (Web Bluetooth security requirement). Always provide services if you plan to read/write.",
            },
          },
        },
      },
      {
        name: "connect_ble_device",
        description: "Connect to a discovered Bluetooth LE device by ID obtained from scan_ble_devices.",
        inputSchema: {
          type: "object",
          properties: {
            deviceId: { type: "string", description: "The unique ID of the device to connect to." },
            services: {
              type: "array",
              items: { type: "string" },
              description: "The same service UUIDs that were passed to scan_ble_devices. Required for GATT access security check.",
            },
          },
          required: ["deviceId", "services"],
        },
      },
      {
        name: "read_ble_characteristic",
        description: "Read the value of a GATT characteristic from the connected device. Returns value as hex string.",
        inputSchema: {
          type: "object",
          properties: {
            deviceId: { type: "string", description: "The ID of the connected device." },
            serviceUuid: { type: "string", description: "The UUID of the GATT service." },
            characteristicUuid: { type: "string", description: "The UUID of the characteristic to read." },
          },
          required: ["deviceId", "serviceUuid", "characteristicUuid"],
        },
      },
      {
        name: "write_ble_characteristic",
        description: "Write a value to a GATT characteristic on the connected device.",
        inputSchema: {
          type: "object",
          properties: {
            deviceId: { type: "string", description: "The ID of the connected device." },
            serviceUuid: { type: "string", description: "The UUID of the GATT service." },
            characteristicUuid: { type: "string", description: "The UUID of the characteristic to write." },
            valueHex: { type: "string", description: "Hex-encoded payload to write (e.g. '01a5ff')." },
          },
          required: ["deviceId", "serviceUuid", "characteristicUuid", "valueHex"],
        },
      },
    ],
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_bridge_status": {
        await waitConnected(2000);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              bridgeHubConnected: ws && ws.readyState === 1,
              phoneConnected,
              pendingRequestsCount: pendingRequests.size,
            }, null, 2),
          }],
        };
      }
      case "scan_ble_devices": {
        const result = await sendToolRequest("scan", { services: args?.services || [] });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "connect_ble_device": {
        const result = await sendToolRequest("connect", {
          deviceId: args.deviceId,
          services: args.services,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "read_ble_characteristic": {
        const result = await sendToolRequest("read", {
          deviceId: args.deviceId,
          serviceUuid: args.serviceUuid,
          characteristicUuid: args.characteristicUuid,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "write_ble_characteristic": {
        const result = await sendToolRequest("write", {
          deviceId: args.deviceId,
          serviceUuid: args.serviceUuid,
          characteristicUuid: args.characteristicUuid,
          valueHex: args.valueHex,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message || String(error) }],
    };
  }
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error('[MCP] Connected to stdio transport');
