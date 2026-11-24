import { Link, useLocation } from 'react-router';
import { PageHeading } from '../../app/page-state.js';

export function CardInspector() {
  const { search } = useLocation();
  return (
    <aside className="card-inspector" aria-labelledby="card-heading">
      <header className="inspector-header">
        <PageHeading id="card-heading" level="h2">Card</PageHeading>
        <Link aria-label="Close card" className="close-card" to={{ pathname: '..', search }}>
          <span aria-hidden="true">×</span>
        </Link>
      </header>
      <p className="inspector-status">Card details are unavailable.</p>
    </aside>
  );
}
