import { afterEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalSetupWizard } from '../apps/web/src/LocalSetupWizard.tsx';

const installer = 'https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-latest/Promo-Iaulin-Setup.exe';

function renderFor(userAgent: string, platform = '', maxTouchPoints = 0) {
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
  return renderToStaticMarkup(createElement(LocalSetupWizard, { onClose: () => undefined }));
}

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5],
  ['Android', 'Mozilla/5.0 (Linux; Android 15; Pixel 8) Mobile', 'Linux armv8l', 5],
  ['iPad', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad', 5],
  ['iPadOS em modo desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 5],
])('não oferece executável Windows em %s', (_label, userAgent, platform, maxTouchPoints) => {
  const html = renderFor(userAgent, platform, maxTouchPoints);
  expect(html).not.toContain(`href="${installer}"`);
  expect(html).toContain('O instalador .exe funciona no Windows');
});

test('oferece download oficial em navegador Windows', () => {
  const html = renderFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32');
  expect(html).toContain(`href="${installer}"`);
  expect(html).not.toContain('O instalador .exe funciona no Windows');
});
