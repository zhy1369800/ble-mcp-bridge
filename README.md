# iOS BLE-MCP Bridge

Control iPhone Bluetooth Low Energy (BLE) devices from any AI agent (Cursor, Claude Desktop, etc.) via a WebSocket bridge and the [beacio](https://beacio.com) Safari extension.

## How It Works

```
AI Agent (PC)
  └─ MCP stdio ─► server.js
                    └─ WebSocket (wss) ─► bridge.js (HTTPS hub, port 3000)
                                            └─ WebSocket ─► iPhone Safari (index.html)
                                                              └─ beacio extension ─► BLE Radio
```

1. **`bridge.js`** — HTTPS + WebSocket hub running on your PC (port 3000). Serves the bridge webpage and relays messages between the AI client and your iPhone.
2. **`server.js`** — Lightweight MCP server connected to your AI editor via stdio. Forwards tool calls to the bridge hub.
3. **`public/index.html`** — The bridge webpage opened on your iPhone. Uses the beacio Safari extension to execute Web Bluetooth commands.

---

## Features

- 🔵 Scan, connect, read and write BLE devices from your iPhone via AI
- 🔒 HTTPS with auto-generated self-signed cert (includes IP SAN for LAN access)
- 🎵 Silent AudioContext background keep-alive (page stays alive when Safari is backgrounded)
- 🔄 Auto WebSocket reconnect on foreground return
- 🔔 System Notification support (desktop browsers)
- 🛡️ Full error handling — no unhandled crashes

---

## Prerequisites

- **Node.js** v18+ on your PC
- **iPhone** with [beacio app](https://apps.apple.com/app/id6761301368) installed and Safari extension enabled ("Always Allow on Every Website")
- PC and iPhone on the **same network** (Wi-Fi or Tailscale)

---

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Bridge Hub

```bash
npm start
```

On first run, it generates `cert.pem` / `key.pem` for HTTPS. The terminal will print all your local IP addresses:

```
======================================================
[BRIDGE] Hub Server listening on HTTPS port 3000
[BRIDGE] Open this URL in Safari on your iPhone:
   👉 https://192.168.1.100:3000
======================================================
```

### 3. Connect Your iPhone

1. Open Safari on your iPhone and navigate to the URL shown above.
2. Safari will warn about the self-signed certificate — tap **"visit this website"** at the bottom to proceed.
3. On the bridge webpage, verify:
   - **Bridge Server (WS)**: Connected (Green)
   - **Safari Extension**: Active (beacio) (Green)
4. Tap **Enable** on the **Background Keep-Alive** row to keep the page alive when you switch apps.

---

## Integrate with Your AI Editor

### Antigravity / Cursor

Add to your MCP config (adjust the path to wherever you cloned this repo):

```json
{
  "mcpServers": {
    "ble-bridge": {
      "command": "node",
      "args": ["/path/to/ble-mcp-bridge/server.js"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ble-bridge": {
      "command": "node",
      "args": ["/path/to/ble-mcp-bridge/server.js"]
    }
  }
}
```

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `get_bridge_status` | Check if iPhone bridge is connected |
| `scan_ble_devices` | Scan for nearby BLE devices (triggers user approval on iPhone) |
| `connect_ble_device` | Connect to a paired device by ID |
| `read_ble_characteristic` | Read a GATT characteristic value (returns hex) |
| `write_ble_characteristic` | Write a hex value to a GATT characteristic |

---

## Example Prompts

```
Check if my iPhone bridge is connected.
```
```
Scan for nearby Bluetooth devices with the heart_rate service.
```
```
Connect to device <id> with services ['heart_rate'].
```
```
Read the battery level (service '180f', characteristic '2a19') from my connected device.
```

---

## Notes

- **AirPods / Apple devices**: Cannot be connected via Web Bluetooth (iOS system restriction).
- **Classic Bluetooth**: Not supported. Only BLE (Low Energy) devices work.
- **Scan requires user gesture**: When scanning for a *new* device, you must tap the Approve button on the iPhone. Once connected, all read/write operations run silently in the background.
- **Self-signed cert**: Delete `cert.pem` / `key.pem` and restart `bridge.js` to regenerate with updated IP SANs if your network changes.

---

## License

MIT
