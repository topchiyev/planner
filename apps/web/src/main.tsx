import { PLANNER_VERSION } from '@planner/contracts';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Planner root element is missing');
}

createRoot(container).render(<h1 data-version={PLANNER_VERSION}>Planner</h1>);
