import { type ReactNode, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';

interface PageHeadingProps {
  children: ReactNode;
  focus?: boolean;
  id?: string;
  level?: 'h1' | 'h2';
}

export function PageHeading({ children, focus = true, id, level: Heading = 'h1' }: PageHeadingProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus, pathname]);

  return <Heading id={id} ref={heading} tabIndex={-1}>{children}</Heading>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true"><span /></span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

export function RoutePending() {
  return <section className="page"><p className="route-status" role="status">Loading…</p></section>;
}

export function RouteError() {
  return (
    <section className="page route-error">
      <PageHeading>Page couldn’t load</PageHeading>
      <p>Try loading this page again.</p>
      <button className="primary-button" onClick={() => window.location.reload()} type="button">Retry</button>
    </section>
  );
}

export function RouteNotFound() {
  return (
    <section className="page route-error">
      <PageHeading>Page not found</PageHeading>
      <Link to="/workspace">Go to projects</Link>
    </section>
  );
}
