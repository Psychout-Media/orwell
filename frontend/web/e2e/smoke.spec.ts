import { expect, test, type Page } from '@playwright/test';

const USER = process.env.PLAY_USER ?? 'admin';
const PASSWORD = process.env.PLAY_PASSWORD ?? 'play-test-pw';

async function signIn(page: Page): Promise<void> {
  const r = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } });
  expect(r.ok()).toBeTruthy();
}

const userBubbles = (page: Page) => page.getByTestId('msg-user');
const aiBubbles = (page: Page) => page.getByTestId('msg-ai');

test('logged out: /play sends you to sign in, never a blank page', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/play');
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test('load, send, stream, reload: no lost or doubled messages', async ({ page }) => {
  await signIn(page);
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/play');
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('transcript')).toBeVisible();
  await expect(page.getByTestId('room-strip')).toBeVisible();
  const before = { u: await userBubbles(page).count(), a: await aiBubbles(page).count() };

  const marker = `smoke-${Date.now()}`;
  await page.getByLabel('Say or do something').fill(`I wave hello ${marker}`);
  await page.getByTestId('send').click();

  // The reply streams into a live bubble, then settles into a stored one.
  await expect(page.getByTestId('msg-live')).toBeVisible();
  await expect(page.getByTestId('msg-live')).toHaveCount(0, { timeout: 30_000 });
  await expect(userBubbles(page)).toHaveCount(before.u + 1);
  await expect(aiBubbles(page)).toHaveCount(before.a + 1);
  const last = aiBubbles(page).last();
  await expect(last).toContainText(`I wave hello ${marker}`);
  // Reasoning never lands in the public bubble.
  await expect(last.locator('.md-block')).not.toContainText('Production notes');

  // Reload rebuilds from history: same counts, same text, no duplicates.
  await page.reload();
  await expect(aiBubbles(page)).toHaveCount(before.a + 1);
  await expect(userBubbles(page)).toHaveCount(before.u + 1);
  await expect(aiBubbles(page).last()).toContainText(`I wave hello ${marker}`);
  const texts = await aiBubbles(page).allInnerTexts();
  expect(new Set(texts).size).toBe(texts.length);
  expect(consoleErrors).toEqual([]);
});

test('reload while a reply is streaming: the turn is reconciled by clientMsgId, not lost or doubled', async ({ page }) => {
  await signIn(page);
  await page.goto('/play');
  await expect(page.getByTestId('transcript')).toBeVisible();
  const before = { u: await userBubbles(page).count(), a: await aiBubbles(page).count() };

  const marker = `midflight-${Date.now()}`;
  await page.getByLabel('Say or do something').fill(`Mid-flight turn ${marker}`);
  await page.getByTestId('send').click();
  await expect(page.getByTestId('msg-live')).toBeVisible();
  await page.reload();

  await expect(aiBubbles(page)).toHaveCount(before.a + 1, { timeout: 45_000 });
  await expect(userBubbles(page)).toHaveCount(before.u + 1);
  await expect(page.getByTestId('msg-live')).toHaveCount(0);
  await expect(aiBubbles(page).last()).toContainText(`Mid-flight turn ${marker}`);
  // And the server agrees: exactly one user row with this text.
  const hist = await (await page.request.get(`/api/history/${await sessionId(page)}`)).json();
  const mine = (hist.history as Array<{ role: string; content: string }>).filter((m) => m.role === 'user' && String(m.content).includes(marker));
  expect(mine).toHaveLength(1);
});

async function sessionId(page: Page): Promise<string> {
  const r = await page.request.get('/api/orwell/game-session');
  return ((await r.json()) as { sessionId: string }).sessionId;
}

test('decision card: a pending nominations card submits the classic payload with an idempotency key', async ({ page }) => {
  await signIn(page);
  // The seeded game sits at the premiere with nothing pending, so the engine's pending is simulated at the
  // network edge; the POST is captured and never reaches the engine.
  await page.route('**/api/orwell/state', async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    const house = (j.house ?? []).slice(0, 4) as Array<{ id: string; name: string }>;
    j.pending = { kind: 'nominations', prompt: 'Nominate two houseguests.', options: house.map((h) => ({ id: h.id, name: h.name })) };
    await route.fulfill({ response: r, json: j });
  });
  let posted: Record<string, unknown> | null = null;
  await page.route('**/api/orwell/decision', async (route) => {
    posted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { beatSeq: 99 } });
  });
  await page.goto('/play');
  const card = page.getByTestId('decision-card');
  await expect(card).toBeVisible();
  const confirm = page.getByTestId('decision-confirm');
  await expect(confirm).toBeDisabled();
  const options = card.locator('button[aria-pressed]');
  await options.nth(0).click();
  await expect(confirm).toBeDisabled(); // two are required
  await options.nth(1).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(card).toContainText('Locked in');
  expect(posted).toMatchObject({ kind: 'nominations' });
  expect((posted as unknown as { choice: string[] }).choice).toHaveLength(2);
  expect(String((posted as unknown as { idempotency_key: string }).idempotency_key)).toMatch(/^dec:nominations\|/);
});
