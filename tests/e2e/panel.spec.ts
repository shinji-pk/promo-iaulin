import { test, expect } from '@playwright/test';

test('salva preferências pela interface e recupera após recarregar', async ({ page }, testInfo) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/#messages');
  await expect(page.getByRole('heading',{name:'A sua voz'})).toBeVisible();
  const signature=`Escolhas com cuidado · ${testInfo.project.name}`;
  await page.getByLabel('Assinatura das mensagens').fill(signature);
  await page.getByRole('button',{name:'Salvar preferências',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Preferências salvas');
  await page.reload();
  await expect(page.getByLabel('Assinatura das mensagens')).toHaveValue(signature);
  await page.goto('/#automation');
  await page.getByLabel('Score mínimo para publicar').focus();
  await page.getByLabel('Score mínimo para publicar').press('End');
  await page.getByLabel('Score mínimo para publicar').press('ArrowLeft');
  await page.getByRole('button',{name:'Salvar preferências',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Preferências salvas');
  await page.reload();
  await expect(page.getByLabel('Score mínimo para publicar')).toHaveValue('99');
  expect(errors).toEqual([]);
});

test('simula, revisa e registra rejeição sem envio real', async ({ page }, testInfo) => {
  const title=`Organizador para casa ${testInfo.project.name}`;
  await page.goto('/#queue');
  await page.getByRole('button',{name:'Simular oferta',exact:true}).click();
  const simulator=page.getByRole('dialog');
  await simulator.getByLabel('Mensagem para simular').fill(`${title}\nDe R$ 89,90 por R$ 49,90\nCupom: CASA10\nhttps://www.amazon.com.br/dp/${testInfo.project.name==='desktop'?'B0E2E00001':'B0E2E00002'}`);
  await simulator.getByRole('button',{name:'Simular oferta',exact:true}).click();
  await expect(simulator.getByText('1 oferta processada',{exact:true})).toBeVisible();
  await simulator.getByRole('button',{name:new RegExp(title)}).click();
  const detail=page.getByRole('dialog');
  await expect(detail.getByText('SIMULAÇÃO · Esta oferta nunca será enviada ao WhatsApp.',{exact:true})).toBeVisible();
  await expect(detail.getByRole('button',{name:'Publicar agora'})).toBeDisabled();
  await expect(detail.getByText('Afiliação precisa de atenção',{exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'Rejeitar',exact:true}).click();
  await detail.getByLabel('O que podemos aprender com essa escolha?').fill('Teste de curadoria sem envio');
  await detail.getByRole('button',{name:'Confirmar rejeição'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  const response=await page.request.get('/api/v1/state');
  const state=await response.json();
  const offer=state.offers.find((item:{title:string})=>item.title===title);
  expect(offer).toMatchObject({simulation:true,status:'rejected',publishedAt:null});
  expect(state.feedbackCount).toBeGreaterThan(0);
  expect(state.stats.published).toBe(0);
});

test('abre as páginas, guia e navegação responsiva sem erros', async ({ page },testInfo) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Um novo dia, boas escolhas.'})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('dashboard.png'),fullPage:true});
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Explorar por conta própria'}).click();
  if(testInfo.project.name==='mobile') await page.getByRole('button',{name:'Abrir navegação'}).click();
  await page.getByRole('button',{name:'Fontes & conexões',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Fontes & conexões.'})).toBeVisible();
  const routes=['affiliates','audience','automation','messages','health','settings','published','discover'];
  for(const route of routes){
    await page.goto(`/#${route}`);
    await expect(page.locator('main h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('demonstração estática funciona sem API e nunca oferece envio real',async({page},testInfo)=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://demonstracao.localhost:4174/#queue');
  await expect(page.getByText('Você está em uma demonstração.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Simular oferta',exact:true}).click();
  const simulator=page.getByRole('dialog');
  await simulator.getByLabel('Mensagem para simular').fill('Sérum facial vitamina C\nPor R$ 39,90\nhttps://www.amazon.com.br/dp/B0E2E00003');
  await simulator.getByRole('button',{name:'Simular oferta',exact:true}).click();
  await expect(simulator.getByText('1 oferta processada',{exact:true})).toBeVisible();
  await simulator.getByRole('button',{name:/Sérum facial vitamina C/}).click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Publicar agora'})).toBeDisabled();
  await page.getByRole('dialog').getByRole('button',{name:'Fechar',exact:true}).click();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Sérum facial vitamina C',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('demonstracao.png'),fullPage:true});
  expect(errors).toEqual([]);
});
