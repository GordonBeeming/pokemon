import { StrictMode } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

function Scaffold(): ReactElement {
  return (
    <main>
      <h1>Pokédex</h1>
      <p>Your private card catalogue is ready for its first collection.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing');
createRoot(root).render(
  <StrictMode>
    <Scaffold />
  </StrictMode>,
);
