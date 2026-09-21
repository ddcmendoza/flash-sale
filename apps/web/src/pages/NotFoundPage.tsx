import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="shell">
      <header>
        <h1>Flash Drop</h1>
      </header>
      <p className="msg msg-error">This page doesn't exist.</p>
      <Link className="admin-link" to="/">
        ← back to the demo
      </Link>
    </main>
  );
}