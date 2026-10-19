import { parseSecureUrl } from '../common.ts';
import type { Product } from '../../../shared/src/index.ts';
import type { ProviderContext } from './types.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
class ProviderHttpError extends Error {}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function credential(context: ProviderContext, key: string, label: string): string {
  const value = context.credentials[key];
  // eslint-disable-next-line no-control-regex -- Secrets must never become invalid HTTP header values.
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Informe ${label} nas credenciais locais da integração.`);
  }
  return value.trim();
}

export function requireProduct(context: ProviderContext, identify: (url: URL) => Product | null): Product {
  const url = parseSecureUrl(context.product.canonicalUrl);
  const product = url ? identify(url) : null;
  if (!product || product.productKey !== context.product.productKey || product.productId !== context.product.productId || product.platform !== context.product.platform) {
    throw new Error('O endereço precisa identificar exatamente um produto da loja selecionada.');
  }
  return product;
}

export function returnedUrl(value: unknown): URL | null {
  return typeof value === 'string' && value.length <= 2048 ? parseSecureUrl(value) : null;
}

/** Fixed official endpoints only. Never follow a redirect while carrying API credentials. */
export async function requestJson(context: ProviderContext, endpoint: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (context.fetch ?? globalThis.fetch)(endpoint, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ProviderHttpError('Acesso à API não autorizado. Confira credenciais, aprovação e permissões da conta.');
      if (response.status === 429) throw new ProviderHttpError('A API atingiu o limite de solicitações. Aguarde antes de tentar novamente.');
      throw new ProviderHttpError('A API da loja não concluiu a solicitação. Tente novamente mais tarde.');
    }
    if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new ProviderHttpError('A API devolveu uma resposta inválida ou muito grande.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ProviderHttpError('A API devolveu uma resposta inválida ou muito grande.');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new ProviderHttpError('A API devolveu uma resposta inválida.'); }
    const result = record(parsed);
    if (!result) throw new ProviderHttpError('A API devolveu uma resposta inválida.');
    return result;
  } catch (error) {
    // Do not expose fetch errors, URLs, bodies or provider error messages containing credentials.
    if (error instanceof ProviderHttpError) throw error;
    // eslint-disable-next-line preserve-caught-error -- A cause can retain API credentials or token-bearing request details.
    throw new Error(controller.signal.aborted ? 'A API da loja demorou demais para responder. Tente novamente.' : 'Não foi possível acessar a API da loja. Confira a conexão e tente novamente.');
  } finally {
    clearTimeout(timer);
    if (reader) {
      try { await reader.cancel(); } catch { /* The HTTP stream may already be closed or aborted. */ }
    }
  }
}
