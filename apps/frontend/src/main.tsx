import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router.js';
import './app/styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Planner root element is missing');
}

createRoot(container).render(<RouterProvider router={router} />);
