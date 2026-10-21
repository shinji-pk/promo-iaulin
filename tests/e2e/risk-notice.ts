import type { Page } from '@playwright/test';

/** O aviso de uso do WhatsApp bloqueia o painel até ser aceito; os testes aceitam sempre que ele aparecer. */
export async function acceptRiskNoticeWhenShown(page: Page): Promise<void> {
  const gate = page.getByRole('dialog', { name: /Proteja o seu número/ });
  await page.addLocatorHandler(gate, async () => {
    for (const label of await gate.locator('fieldset label').all()) {
      if (!(await label.getAttribute('class'))?.includes('on')) await label.click();
    }
    await gate.getByRole('button', { name: /Entendi e aceito/ }).click();
  });
}
