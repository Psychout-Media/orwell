/**
 * ORW-684: reads no longer fold (looking at a game must not change it); the bond record and the grudge book fold at the commit funnel.
 * A test that edits a session's internals directly and then reads has no commit in between, so it runs the commit's fold first, as the funnel would.
 */
export const atCommit = <T extends object>(session: T): T => {
  (session as unknown as { foldAtCommit(): void }).foldAtCommit();
  return session;
};
