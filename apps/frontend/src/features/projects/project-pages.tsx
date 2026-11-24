import { Link } from 'react-router';
import { EmptyState, PageHeading } from '../../app/page-state.js';

export function WorkspacePage() {
  return (
    <section className="page" aria-labelledby="page-heading">
      <header className="page-header">
        <PageHeading id="page-heading">Projects</PageHeading>
      </header>
      <EmptyState title="No projects to show">Projects you can access will appear here.</EmptyState>
    </section>
  );
}

export function ProjectPage() {
  return (
    <section className="page" aria-labelledby="page-heading">
      <header className="page-header">
        <nav aria-label="Breadcrumb"><Link to="/workspace">Projects</Link></nav>
        <PageHeading id="page-heading">Project</PageHeading>
      </header>
      <EmptyState title="No boards to show">Boards you can access in this project will appear here.</EmptyState>
    </section>
  );
}
