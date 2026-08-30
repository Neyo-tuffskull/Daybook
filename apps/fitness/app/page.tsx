export default function Page() {
  return (
    <main
      style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--db-space-8) var(--db-space-4)' }}
    >
      <h1 style={{ fontSize: 28, letterSpacing: '-0.02em', margin: 0 }}>Fitness</h1>
      <p style={{ color: 'var(--db-ink-2)', marginTop: 'var(--db-space-3)' }}>
        Log the work, and let the day update itself.
      </p>
      <p style={{ color: 'var(--db-muted)', fontFamily: 'var(--db-font-mono)', fontSize: 13 }}>
        Phase 2 scaffold. Features arrive in Phase 4.
      </p>
    </main>
  );
}
