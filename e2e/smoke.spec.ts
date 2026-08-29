import { test, expect } from '@playwright/test';

// Phase 2 proves only that the stack comes up. The journeys in docs/SYNC.md
// section 10 arrive with the features they describe.
test.describe('the stack is running', () => {
  test('the planner responds', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByRole('heading', { name: 'Daybook' })).toBeVisible();
  });

  test('the fitness app responds', async ({ page }) => {
    await page.goto('/fit');
    await expect(page.getByRole('heading', { name: 'Fitness' })).toBeVisible();
  });

  test('the api reports itself ready', async ({ request }) => {
    const response = await request.get(
      `${process.env.E2E_API_URL ?? 'http://localhost:4000'}/v1/readyz`,
    );
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });
});
