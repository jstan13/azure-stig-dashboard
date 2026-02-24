/**
 * E2E tests for Azure STIG Dashboard (MOCK_MODE=true).
 *
 * These tests exercise the full UI stack against a running docker-compose instance.
 * Start the app first:
 *   docker compose up --build -d
 * Then run:
 *   cd e2e && npm test
 */

import { test, expect, Page } from '@playwright/test';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** In mock mode the login page has a mock bypass notice; we still click sign-in. */
async function loginMock(page: Page) {
  await page.goto('/');
  // In MOCK_MODE the app may already be authenticated server-side, or we see the login page.
  // If the login page is shown, click the sign-in button (MSAL redirect will return immediately
  // in a test environment with mock tokens — for full MSAL testing use a dedicated test tenant).
  if (await page.getByText('Sign in with Azure AD').isVisible()) {
    // Skip real MSAL flow in E2E — navigate directly to dashboard (app is in mock mode)
    await page.goto('/dashboard');
  }
}

// ── Test: Health endpoint ────────────────────────────────────────────────────

test('health endpoint returns ok', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe('ok');
});

// ── Test: Dashboard overview ─────────────────────────────────────────────────

test('dashboard page loads and shows overview', async ({ page }) => {
  await loginMock(page);
  // The page should show KPI cards
  await expect(page.getByText('Total Machines')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Avg Compliance')).toBeVisible();
});

// ── Test: Machine inventory ─────────────────────────────────────────────────

test('inventory page shows machine list', async ({ page }) => {
  await loginMock(page);
  await page.goto('/inventory');
  await expect(page.getByText('Machine Inventory')).toBeVisible({ timeout: 10_000 });
  // Should show at least one machine name
  await expect(page.getByText('WIN10-WORKSTATION-01')).toBeVisible();
});

test('inventory search filters machines', async ({ page }) => {
  await loginMock(page);
  await page.goto('/inventory');
  const searchBox = page.getByPlaceholder('Search name or resource group…');
  await searchBox.fill('WORKSTATION-01');
  await searchBox.press('Enter');
  await expect(page.getByText('WIN10-WORKSTATION-01')).toBeVisible();
  // Other machines should not appear after filtering
  await expect(page.getByText('WIN10-WORKSTATION-02')).not.toBeVisible();
});

// ── Test: Machine detail page ────────────────────────────────────────────────

test('machine detail page shows findings', async ({ page }) => {
  await loginMock(page);
  await page.goto('/inventory');
  // Click the first machine link
  await page.getByText('WIN10-WORKSTATION-01').first().click();
  await page.waitForURL(/\/machines\//);
  await expect(page.getByText('Control Findings')).toBeVisible({ timeout: 10_000 });
  // Export button should be visible
  await expect(page.getByText('Export')).toBeVisible();
});

// ── Test: Export .ckl ───────────────────────────────────────────────────────

test('export endpoint returns valid .ckl XML', async ({ request }) => {
  // Get machine list
  const listRes = await request.get('/api/machines');
  expect(listRes.ok()).toBeTruthy();
  const list = await listRes.json();
  expect(list.data.length).toBeGreaterThan(0);

  const machineId = list.data[0].id;

  // Trigger export
  const exportRes = await request.post('/api/export/checklist', {
    data: { machineId, format: 'ckl' },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(exportRes.ok()).toBeTruthy();
  const xml = await exportRes.text();
  expect(xml).toContain('<CHECKLIST>');
  expect(xml).toContain('<STIGS>');
  expect(xml).toContain('<VULN>');
});

// ── Test: Audit log ─────────────────────────────────────────────────────────

test('audit page shows event timeline', async ({ page }) => {
  await loginMock(page);
  await page.goto('/audit');
  await expect(page.getByText('Audit & History')).toBeVisible({ timeout: 10_000 });
});

// ── Test: Group compliance ──────────────────────────────────────────────────

test('groups page shows resource group list', async ({ page }) => {
  await loginMock(page);
  await page.goto('/groups/all');
  await expect(page.getByText('All Resource Groups')).toBeVisible({ timeout: 10_000 });
});

test('group detail page shows compliance rollup', async ({ page }) => {
  await loginMock(page);
  await page.goto('/groups/rg-demo');
  await expect(page.getByText('Group: rg-demo')).toBeVisible({ timeout: 10_000 });
});
