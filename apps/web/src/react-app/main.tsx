import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/space-grotesk';
import { App } from './app';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing');

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('Service worker registration failed', error);
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
