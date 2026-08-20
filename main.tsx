import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './src/App';
import { ApiKeyGate } from './src/components/ApiKeyGate';
import './src/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiKeyGate>
      <App />
    </ApiKeyGate>
  </StrictMode>,
);
