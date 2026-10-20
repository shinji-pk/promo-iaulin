// Visual QA (temporary, lives only on qa/* branches). Mocks the cloud account API.
import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = "http://promo.test:4174/";
const OUT = "qa-shots"; fs.mkdirSync(OUT, { recursive: true });
const log = [];
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP promo.test 127.0.0.1"] });
const user = { id: "u1", name: "Cindy", email: "cindy@example.com", username: "cindy", phone: "+55 11 90000-0000", image: null };
async function shoot(page, name) { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}.png` }); }
async function click(page, name, role = "button") { const el = page.getByRole(role, { name }).first(); if (await el.count() && await el.isVisible()) { await el.click(); return true; } log.push("missing: " + name); return false; }
for (const [tag, viewport] of [["d", { width: 1440, height: 900 }], ["m", { width: 390, height: 844 }]]) {
  for (const logged of [false, true]) {
    const ctx = await browser.newContext({ viewport });
    await ctx.route("**/api/**", route => {
      const url = new URL(route.request().url());
      const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/v1/account/capabilities") return json(200, { passwordRecovery: true, emailChange: true });
      if (url.pathname === "/api/v1/account") return json(200, { mode: "cloud", persistence: "cloud", managed: false, workerConnected: false, user: logged ? user : null });
      return json(404, { error: "not found" });
    });
    const page = await ctx.newPage();
    page.on("pageerror", e => log.push(`${tag} pageerror ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) log.push(`${tag} console ${m.text()}`); });
    await page.goto(BASE);
    if (!logged) {
      await shoot(page, `01-login-${tag}`);
      if (await click(page, "Criar conta", "tab")) await shoot(page, `02-signup-${tag}`);
      await click(page, "Entrar", "tab");
      if (await click(page, "Esqueci minha senha")) await shoot(page, `03-esqueci-${tag}`);
    } else {
      await shoot(page, `04-hoje-${tag}`);
      if (tag === "m") { await click(page, "Abrir navegação"); await shoot(page, `05-menu-${tag}`); await page.keyboard.press("Escape"); }
      for (const [i, label] of ["Fila de curadoria", "Fontes & conexões", "Configurações"].entries()) {
        if (tag === "m") await click(page, "Abrir navegação");
        if (await click(page, label)) await shoot(page, `0${6 + i}-${label.split(" ")[0].toLowerCase()}-${tag}`);
      }
      if (await click(page, "Minha conta")) await shoot(page, `09-minha-conta-${tag}`);
      await page.keyboard.press("Escape");
      if (await click(page, "Guia do seu grupo de vendas")) await shoot(page, `10-guia-${tag}`);
    }
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(`${OUT}/log.txt`, log.join("\n") + "\n");
console.log(log.join("\n"));
