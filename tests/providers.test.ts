import { afterEach, describe, expect, it, vi } from 'vitest';
import { identifyProduct } from '../packages/affiliate-adapters/src/index.ts';
import { aliexpressLegacyProvider, amazonCreatorsProvider, defaultProviders, shopeeOfficialProvider, type ProviderContext } from '../packages/affiliate-adapters/src/providers/index.ts';
import { defaultSettings, type PlatformId } from '../packages/shared/src/index.ts';

const NOW = 1_792_326_896_000; // 2026-10-18T12:34:56Z; TOP timestamp must be GMT+8.
const urls = {
  amazon: 'https://www.amazon.com.br/dp/B0TEST0001',
  shopee: 'https://shopee.com.br/product/123/456',
  aliexpress: 'https://www.aliexpress.com/item/1005000000000001.html'
};
const credentials = {
  amazon: { credentialId: 'fixture-amazon-id', credentialSecret: 'fixture-amazon-secret', credentialVersion: '3.1' },
  shopee: { appId: '12345', secret: 'fixture-shopee-secret', contractConfirmed: 'true' },
  aliexpress: { appKey: 'fixture-app-key', appSecret: 'fixture-ali-secret', trackingId: 'fixture-tracking', legacyContractConfirmed: 'true' }
};
const amazonUrl = `${urls.amazon}?tag=fixture-20&language=pt_BR&linkCode=ogi&th=1&psc=1`;
const token = { access_token: 'fixture-opaque-token', token_type: 'bearer', expires_in: 3600 };
const amazonResponse = (url: unknown = amazonUrl, key = 'itemsResult', asin = 'B0TEST0001') => ({ [key]: { items: [{ asin, detailPageURL: url }] } });
const shopeeResponse = (url: unknown = 'https://s.shopee.com.br/fixture123') => ({ data: { generateShortLink: { shortLink: url } } });
const aliResponse = (overrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}) => ({
  aliexpress_affiliate_link_generate_response: { resp_result: {
    resp_code: 200, resp_msg: 'success', result: {
      tracking_id: 'fixture-tracking', promotion_links: { promotion_link: [{ source_value: urls.aliexpress, promotion_link: 'https://s.click.aliexpress.com/e/_fixture', ...overrides }] }, ...resultOverrides
    }
  } }
});

function fixtureFetch(...responses: unknown[]) {
  const pending = [...responses];
  return vi.fn<typeof fetch>(async () => {
    if (!pending.length) throw new Error('Unexpected fixture request');
    const response = pending.shift();
    return response instanceof Response ? response : Response.json(response);
  });
}

function context(platform: keyof typeof urls, fetcher: typeof fetch): ProviderContext {
  const config = defaultSettings().affiliates[platform];
  config.enabled = true;
  config.publicId = platform === 'amazon' ? 'fixture-20' : '';
  return { product: identifyProduct(urls[platform])!, config, credentials: { ...credentials[platform] }, fetch: fetcher, now: () => NOW };
}

afterEach(() => vi.useRealTimers());

describe('Amazon Creators API client with authenticated fixtures', () => {
  it.each(['itemsResult', 'itemResults'])('uses OAuth and accepts the documented %s envelope', async key => {
    const fetcher = fixtureFetch(token, amazonResponse(amazonUrl, key));
    const result = await amazonCreatorsProvider.convert(context('amazon', fetcher));
    expect(result).toMatchObject({ source: 'amazon', url: amazonUrl });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [authEndpoint, auth] = fetcher.mock.calls[0];
    expect(authEndpoint).toBe('https://api.amazon.com/auth/o2/token');
    expect(auth).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(auth!.body as string)).toEqual({ grant_type: 'client_credentials', client_id: 'fixture-amazon-id', client_secret: 'fixture-amazon-secret', scope: 'creatorsapi::default' });
    const [apiEndpoint, api] = fetcher.mock.calls[1];
    expect(apiEndpoint).toBe('https://creatorsapi.amazon/catalog/v1/getItems');
    expect(api).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fixture-opaque-token', 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com.br' } });
    expect(JSON.parse(api!.body as string)).toEqual({ itemIds: ['B0TEST0001'], itemIdType: 'ASIN', marketplace: 'www.amazon.com.br', partnerTag: 'fixture-20', resources: ['itemInfo.title', 'images.primary.large', 'offersV2.listings.price', 'offersV2.listings.availability'] });
  });

  it.each([
    ['3.1', 'https://api.amazon.com/auth/o2/token'],
    ['3.2', 'https://api.amazon.co.uk/auth/o2/token'],
    ['3.3', 'https://api.amazon.co.jp/auth/o2/token']
  ])('selects token host from credential version %s rather than marketplace', async (version, endpoint) => {
    const fetcher = fixtureFetch(token, amazonResponse());
    const input = context('amazon', fetcher);
    input.credentials.credentialVersion = version;
    await amazonCreatorsProvider.convert(input);
    expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  });

  it('matches ASIN rather than assuming result order', async () => {
    const fetcher = fixtureFetch(token, { itemsResult: { items: [{ asin: 'B0TEST0002', detailPageURL: `${urls.amazon}?tag=wrong-20` }, { asin: 'B0TEST0001', detailPageURL: amazonUrl }] } });
    expect((await amazonCreatorsProvider.convert(context('amazon', fetcher))).url).toBe(amazonUrl);
  });

  it.each([
    undefined, null, '', 'http://www.amazon.com.br/dp/B0TEST0001?tag=fixture-20',
    'https://www.amazon.com.br/dp/B0TEST0002?tag=fixture-20',
    'https://www.amazon.com/dp/B0TEST0001?tag=fixture-20',
    'https://www.amazon.com.br.evil.example/dp/B0TEST0001?tag=fixture-20',
    'https://evil.amazon.com.br/dp/B0TEST0001?tag=fixture-20',
    `${urls.amazon}?tag=other-20`, `${urls.amazon}?tag=fixture-20&tag=fixture-20`,
    `${urls.amazon}?tag=fixture-20&redirect=https://evil.example`, `${urls.amazon}?tag=fixture-20&language=en_US`,
    `${urls.amazon}?tag=fixture-20&language=pt_BR&language=pt_BR`, `${urls.amazon}/redirect?tag=fixture-20`
  ])('rejects a missing, different or unsafe returned link: %s', async returned => {
    const fetcher = fixtureFetch(token, amazonResponse(returned));
    // Undefined intentionally means a missing field rather than the fixture default.
    if (returned === undefined) fetcher.mockImplementationOnce(async () => Response.json(token)).mockImplementationOnce(async () => Response.json({ itemsResult: { items: [{ asin: 'B0TEST0001' }] } }));
    await expect(amazonCreatorsProvider.convert(context('amazon', fetcher))).rejects.toThrow('mesmo produto');
  });

  it('rejects a URL matching input when the response ASIN differs', async () => {
    await expect(amazonCreatorsProvider.convert(context('amazon', fixtureFetch(token, amazonResponse(amazonUrl, 'itemsResult', 'B0TEST0002'))))).rejects.toThrow('mesmo produto');
  });

  it.each([{ access_token: '' }, { access_token: 'unsafe\r\ntoken' }, { access_token: 'okay', token_type: 'basic' }, { errors: ['fixture-secret'] }])('refuses malformed authentication without making catalog calls', async auth => {
    const fetcher = fixtureFetch(auth);
    await expect(amazonCreatorsProvider.convert(context('amazon', fetcher))).rejects.toThrow('token de acesso válido');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported version or forged source identity before HTTP', async () => {
    const fetcher = fixtureFetch();
    const input = context('amazon', fetcher);
    input.credentials.credentialVersion = 'https://evil.example';
    await expect(amazonCreatorsProvider.convert(input)).rejects.toThrow('Versão');
    input.credentials.credentialVersion = '3.1';
    input.product.productId = 'B0TEST0002';
    await expect(amazonCreatorsProvider.convert(input)).rejects.toThrow('exatamente');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Shopee API candidate, explicitly confirmed by operator', () => {
  it('sends the exact signed request with an independent fixed SHA256 fixture', async () => {
    const fetcher = fixtureFetch(shopeeResponse());
    const result = await shopeeOfficialProvider.convert(context('shopee', fetcher));
    expect(result.url).toBe('https://s.shopee.com.br/fixture123');
    expect(result.reason).toContain('confirmado pelo operador');
    const [endpoint, init] = fetcher.mock.calls[0];
    expect(endpoint).toBe('https://open-api.affiliate.shopee.com.br/graphql');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'SHA256 Credential=12345, Timestamp=1792326896, Signature=0da04cb2e5e2ca1ec873faf3d27bce7cb65fe2adddab4232022d40189f572829' } });
    expect(init!.body).toBe(JSON.stringify({ query: 'mutation { generateShortLink(input: { originUrl: "https://shopee.com.br/product/123/456", subIds: ["promobridge","whatsapp"] }) { shortLink } }' }));
    expect(fetcher).toHaveBeenCalledTimes(1); // Never follow the returned affiliate link.
  });

  it.each(['', 'false', 'TRUE', undefined])('blocks unconfirmed contract %s before HTTP', async confirmation => {
    const fetcher = fixtureFetch();
    const input = context('shopee', fetcher);
    if (confirmation === undefined) delete input.credentials.contractConfirmed;
    else input.credentials.contractConfirmed = confirmation;
    await expect(shopeeOfficialProvider.convert(input)).rejects.toThrow('Explorer');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a same-product direct link and rejects another product', async () => {
    expect((await shopeeOfficialProvider.convert(context('shopee', fixtureFetch(shopeeResponse(`${urls.shopee}?utm_campaign=fixture`))))).url).toContain('/123/456');
    await expect(shopeeOfficialProvider.convert(context('shopee', fixtureFetch(shopeeResponse('https://shopee.com.br/product/123/999'))))).rejects.toThrow('link permitido');
  });

  it.each([
    null, {}, '', 'https://s.shopee.com.br/', 'https://s.shopee.com.br/campaign/sale',
    'https://s.shopee.com.br.evil.example/fixture123', 'http://s.shopee.com.br/fixture123',
    'https://shopee.com.br/m/ofertas', 'https://user:secret@s.shopee.com.br/fixture123'
  ])('rejects malformed, landing or hostile output: %s', async url => {
    await expect(shopeeOfficialProvider.convert(context('shopee', fixtureFetch(shopeeResponse(url))))).rejects.toThrow('link permitido');
  });

  it('rejects GraphQL errors even with HTTP 200 and usable-looking data', async () => {
    const response = { ...shopeeResponse(), errors: [{ message: 'secret credential from server' }] };
    const failed = shopeeOfficialProvider.convert(context('shopee', fixtureFetch(response)));
    await expect(failed).rejects.toThrow('recusou');
    await expect(failed).rejects.not.toThrow('secret credential');
  });

  it('limits subIDs and signs the exact escaped query body', async () => {
    const fetcher = fixtureFetch(shopeeResponse());
    const input = context('shopee', fetcher);
    input.credentials.subIds = 'campaign,channel';
    await shopeeOfficialProvider.convert(input);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).query).toContain('subIds: ["campaign","channel"]');
    input.credentials.subIds = '1,2,3,4,5,6';
    await expect(shopeeOfficialProvider.convert(input)).rejects.toThrow('até cinco');
    input.credentials.subIds = 'bad"query';
    await expect(shopeeOfficialProvider.convert(input)).rejects.toThrow('até cinco');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('AliExpress documented legacy TOP family', () => {
  it('uses ordered MD5, legacy gateway, form encoding and GMT+8 independently fixed fixture', async () => {
    const fetcher = fixtureFetch(aliResponse());
    const result = await aliexpressLegacyProvider.convert(context('aliexpress', fetcher));
    expect(result.url).toBe('https://s.click.aliexpress.com/e/_fixture');
    expect(result.reason).toContain('legado');
    const [endpoint, init] = fetcher.mock.calls[0];
    expect(endpoint).toBe('https://eco.taobao.com/router/rest');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
    expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toEqual({
      app_key: 'fixture-app-key', format: 'json', method: 'aliexpress.affiliate.link.generate', promotion_link_type: '0',
      sign_method: 'md5', source_values: urls.aliexpress, timestamp: '2026-10-18 20:34:56', tracking_id: 'fixture-tracking', v: '2.0', sign: '352035570C173CE0E542F23FC4D69B10'
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires the legacy contract confirmation before requesting', async () => {
    const fetcher = fixtureFetch();
    const input = context('aliexpress', fetcher);
    input.credentials.legacyContractConfirmed = 'false';
    await expect(aliexpressLegacyProvider.convert(input)).rejects.toThrow('legada');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { source_value: 'https://www.aliexpress.com/item/1005000000000002.html' },
    { source_value: 'https://www.aliexpress.com' },
    { source_value: undefined }, { promotion_link: undefined },
    { promotion_link: 'https://s.click.aliexpress.com/' },
    { promotion_link: 'https://s.click.aliexpress.com.evil.example/e/_fixture' },
    { promotion_link: 'https://www.aliexpress.com/item/1005000000000002.html' },
    { promotion_link: 'https://www.aliexpress.com/p/campaign' },
    { promotion_link: 'http://s.click.aliexpress.com/e/_fixture' }
  ])('requires a same-product echoed source and safe output: %j', async overrides => {
    await expect(aliexpressLegacyProvider.convert(context('aliexpress', fixtureFetch(aliResponse(overrides))))).rejects.toThrow('mesmo produto');
  });

  it.each([{ tracking_id: 'other-account' }, { tracking_id: undefined }, { promotion_links: {} }])('rejects missing account binding or links: %j', async overrides => {
    await expect(aliexpressLegacyProvider.convert(context('aliexpress', fixtureFetch(aliResponse({}, overrides))))).rejects.toThrow(/Tracking ID|mesmo produto/);
  });

  it('rejects HTTP-200 business and outer TOP errors without echoing payloads', async () => {
    const business = { aliexpress_affiliate_link_generate_response: { resp_result: { resp_code: 400, resp_msg: 'fixture-ali-secret' } } };
    await expect(aliexpressLegacyProvider.convert(context('aliexpress', fixtureFetch(business)))).rejects.toThrow('não confirmou');
    const outer = { error_response: { code: 27, msg: 'fixture-ali-secret' }, ...aliResponse() };
    await expect(aliexpressLegacyProvider.convert(context('aliexpress', fixtureFetch(outer)))).rejects.toThrow('recusou');
  });
});

describe('bounded credential-bearing HTTP requests', () => {
  it.each([401, 403, 429, 500, 302])('sanitizes HTTP %s and never follows redirects', async status => {
    const fetcher = fixtureFetch(new Response('fixture-amazon-secret', { status, headers: { location: 'https://evil.example/steal' } }));
    const failed = amazonCreatorsProvider.convert(context('amazon', fetcher));
    await expect(failed).rejects.toThrow(/API/);
    await expect(failed).rejects.not.toThrow('fixture-amazon-secret');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]!.redirect).toBe('error');
  });

  it('does not trust or propagate arbitrary exception text', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('A API leaked fixture-amazon-secret https://evil.example'); });
    const failed = amazonCreatorsProvider.convert(context('amazon', fetcher));
    await expect(failed).rejects.toThrow('Não foi possível acessar');
    await expect(failed).rejects.not.toThrow('fixture-amazon-secret');
  });

  it.each([
    new Response('fixture-amazon-secret'), Response.json([]),
    new Response('{}', { headers: { 'content-length': String(513 * 1024) } }),
    new Response(' '.repeat(513 * 1024))
  ])('refuses invalid JSON, shape and oversized bodies without exposing them', async response => {
    await expect(amazonCreatorsProvider.convert(context('amazon', fixtureFetch(response)))).rejects.toThrow('resposta inválida');
  });

  it('aborts credential-bearing fetch after the request deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('fixture-amazon-secret timeout')), { once: true });
    }));
    const result = amazonCreatorsProvider.convert(context('amazon', fetcher));
    const assertion = expect(result).rejects.toThrow('demorou demais');
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
  });

  it('registers only implemented API providers and never pretends all stores have one', () => {
    expect(Object.keys(defaultProviders).sort()).toEqual(['aliexpress', 'amazon', 'shopee']);
    expect(defaultProviders['temu' as PlatformId]).toBeUndefined();
  });
});
