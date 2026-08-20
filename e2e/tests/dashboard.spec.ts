/**
 * E2E tests for Azure STIG Dashboard (MOCK_MODE=true).
 *
 * These tests exercise the full UI stack against a running docker-compose instance.
 * Start the app first:
 *   docker compose up --build -d
 * Then run:
 *   cd e2e && npm test
 */

import { test, expect } from '@playwright/test';

/** The backend is reached directly; nginx only proxies /api/, not /health. */
const API_URL = process.env.E2E_API_URL || 'http://localhost:3001';

// ── API surface (reachable without signing in — MOCK_MODE injects a principal) ─

test.describe('API', () => {
  test('health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${API_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('machine list is served through the nginx /api proxy', async ({ request }) => {
    const res = await request.get('/api/machines');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.data.length).toBeGreaterThan(0);
  });

  test('export endpoint returns valid .ckl XML', async ({ request }) => {
    const listRes = await request.get('/api/machines');
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.data.length).toBeGreaterThan(0);

    const machineId = list.data[0].id;

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
});

// ── Unauthenticated shell ────────────────────────────────────────────────────

test.describe('SPA shell', () => {
  test('boots straight into the app in demo mode, with the demo warning shown', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mock-mode-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Sign in with Azure AD')).toHaveCount(0);
  });

  test('unknown routes fall back to the SPA rather than 404ing', async ({ request }) => {
    const res = await request.get('/inventory');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  test('nginx sends the security headers configured in nginx.conf', async ({ request }) => {
    const res = await request.get('/');
    const headers = res.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

// ── Authenticated UI ─────────────────────────────────────────────────────────
// Reachable because MOCK_MODE skips the MSAL gate, matching the backend, which
// injects a synthetic principal in the same mode.

test.describe('Authenticated UI', () => {
  test('dashboard page loads and shows overview', async ({ page }) => {
    await page.goto('/dashboard');
    // The page should show KPI cards
    await expect(page.getByText('Total Machines')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Avg Compliance')).toBeVisible();
  });

  test('inventory page shows machine list', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.getByText('Machine Inventory')).toBeVisible({ timeout: 10_000 });
    // Should show at least one machine name
    await expect(page.getByText('WIN10-WORKSTATION-01')).toBeVisible();
  });

  test('inventory search filters machines', async ({ page }) => {
    await page.goto('/inventory');
    const searchBox = page.getByPlaceholder('Search name or resource group…');
    await searchBox.fill('WORKSTATION-01');
    await searchBox.press('Enter');
    await expect(page.getByText('WIN10-WORKSTATION-01')).toBeVisible();
    // Other machines should not appear after filtering
    await expect(page.getByText('WIN10-WORKSTATION-02')).not.toBeVisible();
  });

  test('machine detail page shows findings', async ({ page }) => {
    await page.goto('/inventory');
    // Click the first machine link
    await page.getByText('WIN10-WORKSTATION-01').first().click();
    await page.waitForURL(/\/machines\//);
    await expect(page.getByText('Control Findings')).toBeVisible({ timeout: 10_000 });
    // Export button should be visible
    await expect(page.getByText('Export')).toBeVisible();
  });

  test('audit page shows event timeline', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByText('Audit & History')).toBeVisible({ timeout: 10_000 });
  });

  test('groups page shows resource group list', async ({ page }) => {
    await page.goto('/groups/all');
    await expect(page.getByText('All Resource Groups')).toBeVisible({ timeout: 10_000 });
  });

  test('group detail page shows compliance rollup', async ({ page }) => {
    await page.goto('/groups/rg-demo');
    await expect(page.getByText('Group: rg-demo')).toBeVisible({ timeout: 10_000 });
  });
});
