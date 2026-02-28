import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { initStoreWiring } from './mw/ws/ws-store-wiring.js';
import { wsClient } from './mw/ws/ws-client.js';

// Initialise store wiring (WS events → Zustand store actions)
initStoreWiring();

// Connect WebSocket to the backend
wsClient.connect();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
