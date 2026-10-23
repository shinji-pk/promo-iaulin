import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const installer = readFileSync('installer/native/Program.cs', 'utf8');
const wizard = readFileSync('apps/web/src/LocalSetupWizard.tsx', 'utf8');
const download = 'https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-latest/Promo-Iaulin-Setup.exe';

describe('desktop installation after Emet integration', () => {
  it('lets visitors download the public installer even when a proxy requires authentication', () => {
    expect(wizard).toContain(`href="${download}"`);
    expect(wizard).not.toContain('href="/api/v1/download/windows"');
  });
  it('opens the paired desktop session in the Promo module of Emet', () => {
    expect(installer).toContain('https://emet.shinjiapps.com/promo/#worker-pair=');
    expect(installer).not.toContain('https://iaulinbot.vercel.app/#worker-pair=');
  });
});
