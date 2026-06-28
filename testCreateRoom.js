const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:5000');

ws.on('open', () => {
  console.log('WS Connected to server');
  
  const payload = {
    type: 'createRoom',
    fileUrl: 'http://localhost:5000/api/vault/files/stream/6a258998d28db5624e7affe4/VID-20260607-WA0011.mp4?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhMjU4NWRlODFlNzAwODY3MTZjOGFmNyIsImlhdCI6MTc4MDkxNTUyMywiZXhwIjoxNzgzNTA3NTIzfQ.EKihiuXMTUb6dsa06-FTrZmMg0oA99-YmRj1RdB_trg',
    title: 'VID-20260607-WA0011.mp4',
    fileId: '6a258998d28db5624e7affe4',
    hostId: '6a2585de81e70086716c8af7',
    hostAvatarKey: null,
    hostName: 'Bhishan Web Test'
  };
  
  ws.send(JSON.stringify(payload));
  console.log('Sent createRoom payload:', payload);
});

ws.on('message', (data) => {
  console.log('Received from server:', data.toString());
  ws.close();
});

ws.on('error', (err) => {
  console.error('WS Error:', err);
});

ws.on('close', () => {
  console.log('WS Connection closed');
});
