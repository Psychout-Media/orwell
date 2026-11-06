export function LoggedOut() {
  return (
    <main className="center-card" data-testid="logged-out">
      <h1>Signed out</h1>
      <p>Your session ended. Sign in again to keep playing. Your game is saved.</p>
      <p>
        <a className="btn-link" href="/login">
          Sign in
        </a>
      </p>
    </main>
  );
}
