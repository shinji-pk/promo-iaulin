// Visual QA (temporary, lives only on qa/* branches). Mocks the cloud account API.
import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = "http://promo.test:4174/";
const OUT = "qa-shots"; fs.mkdirSync(OUT, { recursive: true });
const log = [];
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP promo.test 127.0.0.1"] });
const user = { id: "u1", name: "Cindy", email: "cindy@example.com", username: "cindy", phone: "+55 11 90000-0000", image: null };
async function shoot(page, name) { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}.png` }); }
async function click(page, name, role = "button") { try { const el = page.getByRole(role, typeof name === "string" ? { name, exact: true } : { name }).first(); if (await el.count() && await el.isVisible()) { await el.click({ timeout: 4000, force: true }); return true; } } catch (e) { log.push("click failed: " + name + " " + e.message.split("\n")[0]); return false; } log.push("missing: " + name); return false; }
async function step(label, fn) { try { await fn(); } catch (e) { log.push(`step ${label} failed: ${e.message.split("\n")[0]}`); } }
for (const [tag, viewport] of [["d", { width: 1440, height: 900 }], ["m", { width: 390, height: 844 }]]) {
  for (const logged of [false, true]) {
    const ctx = await browser.newContext({ viewport });
    await ctx.route("**/api/**", route => {
      const url = new URL(route.request().url());
      const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/v1/account/capabilities") return json(200, { passwordRecovery: true, emailChange: true });
      if (url.pathname === "/api/v1/account") return json(200, { mode: "cloud", persistence: "cloud", managed: false, workerConnected: false, user: logged ? user : null });
      if (url.pathname === "/api/v1/session") return logged ? json(404, { error: "x" }) : json(200, { csrfToken: "t" });
      if (url.pathname.startsWith("/api/auth/sign-in")) return json(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
      return json(404, { error: "not found" });
    });
    const page = await ctx.newPage();
    page.on("pageerror", e => log.push(`${tag} pageerror ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/40[14]/.test(m.text())) log.push(`${tag} console ${m.text()}`); });
    await page.goto(BASE);
    if (!logged) {
      await shoot(page, `01-login-${tag}`);
      await page.waitForTimeout(2600); await shoot(page, `01b-login-mascote-${tag}`);
      await step("wrong", async () => { await page.locator('input[name="email"]').fill("cindy@example.com"); for (let i = 0; i < 2; i++) { await page.locator('input[name="password"]').fill("errada"); await click(page, /Entrar na minha conta/); await page.waitForTimeout(600); } await shoot(page, `02-senha-errada-${tag}`); });
      await step("help", async () => { if (await click(page, "Ajuda para entrar")) { await page.locator(".mascot-topics summary").first().click({ force: true }); await shoot(page, `03-ajuda-login-${tag}`); await click(page, "Recuperar minha senha"); await shoot(page, `04-esqueci-${tag}`); } });
    } else {
      await shoot(page, `05-hoje-${tag}`);
      await step("conta", async () => { if (await click(page, "Minha conta")) await shoot(page, `06-minha-conta-${tag}`); await page.keyboard.press("Escape"); await page.waitForTimeout(300); });
      await step("guia", async () => { const l = page.locator(".guide-launcher"); if (await l.count()) { await l.click(); await click(page, "Conta & suporte", "tab"); await shoot(page, `07-guia-conta-${tag}`); } });
    }
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(`${OUT}/log.txt`, log.join("\n") + "\n");
console.log(log.join("\n"));
