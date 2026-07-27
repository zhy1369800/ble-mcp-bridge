import WebSocket from 'ws';

const ws = new WebSocket('wss://localhost:3000/mcp', {
  rejectUnauthorized: false
});

ws.on('open', () => {
  console.log('Connected to bridge as MCP client');
});

ws.on('message', (data) => {
  console.log('Received message:', JSON.parse(data));
  ws.close();
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
});
