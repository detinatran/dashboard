import { expect, test } from '@playwright/test';

test('local self-host mode unlocks premium UI, exports, and dashboard tabs', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem('pro-banner-dismissed-v3');
  });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute(
    'data-wm-event-handlers-ready',
    'true',
    { timeout: 45_000 },
  );

  const verdict = await page.evaluate(async () => {
    const premium = await import('/src/services/panel-gating.ts');
    const exportGate = await import('/src/services/gates/export.ts');
    const anonymous = { user: null, isPending: false } as never;
    return {
      local: premium.isLocalSelfHostedAccess(),
      premium: premium.hasPremiumAccess(anonymous),
      panelReason: premium.getPanelGateReason(anonymous, true),
      exportVerdict: exportGate.evaluateExportGate(anonymous),
      formats: exportGate.evaluateAvailableExportFormats(anonymous),
      tabVerdict: exportGate.evaluateTabCap(anonymous, 99),
    };
  });

  expect(verdict).toEqual({
    local: true,
    premium: true,
    panelReason: 'none',
    exportVerdict: { locked: false, pendingActivation: false },
    formats: ['csv', 'json', 'pdf'],
    tabVerdict: { allowed: true, cap: null, pendingActivation: false },
  });
  await expect(page.locator('.pro-banner')).toHaveCount(0);
  await expect(page.locator('.panel-locked-cta')).toHaveCount(0);
  await expect(page.getByText(/upgrade to pro/i)).toHaveCount(0);
});
