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
