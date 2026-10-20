import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarClock, Check, ChevronDown, Download, ExternalLink, Link2, LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { categoryIds, categoryNames, platformNames, type CategoryId, type Offer, type PlatformId } from '../../../packages/shared/src/index.ts';
import type { ApprovedLink, CredentialStatus, IntegrationGuide, SetupStatus } from '../../../packages/shared/src/features.ts';
import { api, isDemonstration } from './api.ts';
import { Badge, Button, EmptyState, Field, Modal, SectionTitle } from './ui.tsx';

function message(error: unknown) { return error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.'; }
function safeUrl(value: string) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LocalSetupModal({ onClose }: { onClose: () => void }) {
  return <Modal title="Conecte o WhatsApp sem complicação" subtitle="Seu computador faz o trabalho. Não precisa criar conta na Render, instalar Node.js nem abrir CMD." onClose={onClose}>
    <div className="feature-stack">
      <ol className="feature-guide-steps">
        <li><b>Baixe o instalador para Windows:</b> abra a página de versões e selecione o arquivo <b>Promo-Iaulin-Setup.exe</b> na versão de teste disponível.</li>
        <li><b>Instale e abra Promo Iaulin.</b> O servidor local inicia sozinho e pode ficar minimizado próximo ao relógio do Windows.</li>
        <li><b>Conecte seu WhatsApp:</b> clique em <b>Conectar WhatsApp</b> no programa. No celular, abra Dispositivos conectados → Conectar dispositivo e escaneie o QR Code.</li>
        <li><b>Quer usar também pelo site?</b> No programa, clique em <b>Vincular minha conta online</b>, faça login no site e confirme a conexão. Sem copiar códigos ou criar servidor na Render.</li>
      </ol>
      <div className="feature-inline-actions">
        <a className="button button-primary" href="https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-preview-38/Promo-Iaulin-Setup.exe" target="_blank" rel="noopener noreferrer"><Download size={16}/> Baixar programa para Windows (.exe)</a>
        <a className="text-link" href="http://127.0.0.1:3030/#sources" target="_blank" rel="noopener noreferrer">Já instalei: abrir painel local <ExternalLink size={14}/></a>
      </div>
      <div className="notice notice-subtle"><ShieldCheck size={17}/><p><b>Importante:</b> o programa precisa permanecer ativo no computador para receber e enviar ofertas. Fechar somente a aba do site não para o bot. Esta versão de teste ainda precisa de validação com WhatsApp real e não tem assinatura digital; o Windows pode avisar sobre editor desconhecido. Não desative as proteções do sistema.</p></div>
    </div>
    <div className="modal-footer"><Button variant="secondary" onClick={onClose}>Entendi</Button></div>
  </Modal>;
}
export function LocalSetupButton() {
  const [open, setOpen] = useState(false);
  return <><Button variant="secondary" icon={ArrowRight} onClick={() => setOpen(true)}>Usar com meu WhatsApp</Button>{open && <LocalSetupModal onClose={() => setOpen(false)} />}</>;
}

interface RemoteStatus {
  state: 'off' | 'starting' | 'ready' | 'error'; mode: 'temporary' | 'managed' | null;
  publicUrl: string | null; message: string; expiresAt: string | null; activeSessions: number;
  pairing?: { code: string; url: string; expiresAt: string }; qrDataUrl?: string | null;
}
export function RemoteAccessPanel() {
  const local = !isDemonstration() && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [revoke, setRevoke] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    if (!expanded || !local) return;
    let active = true; let pending = false;
    const load = async () => { if (pending) return; pending = true; try { const result = await api.get<RemoteStatus>('/remote'); if (active) { setStatus(result); setError(''); } } catch (reason) { if (active) setError(message(reason)); } finally { pending = false; } };
    void load(); const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [expanded, local]);
  async function action(path: string, body: unknown) {
    if (!local || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await api.post(`/remote/${path}`, body); const next = await api.get<RemoteStatus>('/remote'); setStatus(next); if (path === 'revoke') { setRevoke(false); setNotice('Sessões de celulares revogadas. Use um novo pareamento para conectar novamente.'); } }
    catch (reason) { setError(message(reason)); }
    finally { setToken(''); lock.current = false; setBusy(false); }
  }
  return <details className="advanced-details space-top" onToggle={event => setExpanded(event.currentTarget.open)}><summary><Link2 size={15} />Acessar pelo celular<ChevronDown size={15} /></summary><div className="feature-stack">{!local ? <><p className="muted">No computador que executa o PromoBridge, abra esta opção para gerar um acesso por QR Code. O computador continua responsável pela conexão e pelos envios.</p>{isDemonstration() && <LocalSetupButton />}</> : <>
    <p className="muted">Crie o acesso no computador e leia o QR Code no celular. O computador precisa continuar ligado e com o PromoBridge aberto.</p>{error && <div className="notice notice-warning" role="alert">{error}</div>}{notice && <div className="notice notice-success" role="status">{notice}</div>}{status && <div className="overview-status"><div><b>{status.state === 'ready' ? 'Acesso disponível' : status.state === 'starting' ? 'Preparando o acesso...' : status.state === 'error' ? 'Acesso precisa de atenção' : 'Acesso desativado'}</b><p className="field-hint">{status.message}</p></div><Badge tone={status.state === 'ready' ? 'green' : 'neutral'}>{status.activeSessions} celular(es)</Badge></div>}
    {status?.state === 'ready' && status.pairing && <div className="feature-stack"><div className="connection-visual">{status.qrDataUrl && <img className="qr-image" src={status.qrDataUrl} alt="QR Code para parear o celular com este PromoBridge" />}</div><p className="field-hint">Leia com a câmera do celular. O pareamento vale para um dispositivo e expira às {new Date(status.pairing.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</p><Button variant="secondary" icon={Link2} onClick={() => { void navigator.clipboard.writeText(status.pairing!.url).then(() => setNotice('Link de pareamento copiado. Use somente no seu dispositivo.')).catch(() => setError('Não foi possível copiar. Use a câmera para ler o QR Code.')); }}>Copiar link de pareamento</Button></div>}
    {status?.publicUrl && <p className="field-hint">Endereço: {status.publicUrl}</p>}{status?.mode === 'temporary' && <p className="field-hint">O endereço temporário muda quando você reinicia a conexão. O acesso usa o serviço de túnel da Cloudflare.</p>}
    <div className="feature-inline-actions"><Button variant="secondary" icon={busy ? LoaderCircle : Link2} disabled={busy || status?.state === 'starting' || status?.state === 'ready'} onClick={() => void action('start', { mode: 'temporary' })}>Criar acesso temporário</Button>{status && status.state !== 'off' && <Button variant="ghost" disabled={busy} onClick={() => void action('stop', {})}>Desativar acesso</Button>}{Boolean(status?.activeSessions) && <Button variant="ghost" disabled={busy} onClick={() => setRevoke(true)}>Revogar celulares</Button>}</div>
    <details className="advanced-details"><summary>Avançado · Usar seu túnel Cloudflare<ChevronDown size={15} /></summary><form className="feature-stack" autoComplete="off" onSubmit={event => { event.preventDefault(); if (!safeUrl(publicUrl)) { setError('Informe o endereço público HTTPS do seu túnel.'); return; } void action('start', { mode: 'managed', token: token.trim(), publicUrl: publicUrl.trim() }); }}><p className="field-hint">Configure o túnel oficial para o aplicativo deste computador. O token fica somente no processo local e precisa ser informado novamente após reiniciar.</p><a className="text-link" href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/" target="_blank" rel="noopener noreferrer">Documentação oficial Cloudflare<ExternalLink size={13} /></a><Field label="Endereço HTTPS do seu túnel"><input type="url" required aria-label="Endereço público do túnel" maxLength={2048} value={publicUrl} disabled={busy} onChange={event => setPublicUrl(event.target.value)} placeholder="https://..." /></Field><Field label="Token do túnel gerenciado"><input type="password" required aria-label="Token do túnel Cloudflare" autoComplete="off" maxLength={10000} value={token} disabled={busy} onChange={event => setToken(event.target.value)} /></Field><Button type="submit" variant="secondary" disabled={busy || !token.trim() || !publicUrl.trim() || status?.state === 'starting' || status?.state === 'ready'}>Conectar meu túnel</Button></form></details>
  </>}</div>{revoke && <Modal title="Revogar o acesso dos celulares?" subtitle="Todos os dispositivos pareados vão precisar de um novo QR Code para entrar." onClose={() => setRevoke(false)}><div className="modal-footer"><Button variant="secondary" onClick={() => setRevoke(false)}>Cancelar</Button><Button variant="danger" disabled={busy} onClick={() => void action('revoke', {})}>Revogar acessos</Button></div></Modal>}</details>;
}

export function SetupChecklist({ refreshKey }: { refreshKey?: string }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current; setLoading(true);
    try { const result = await api.get<SetupStatus>('/setup'); if (request === sequence.current) { setSetup(result); setError(''); } }
    catch (reason) { if (request === sequence.current) setError(message(reason)); }
    finally { if (request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load, refreshKey]);
  return <details className="advanced-details setup-readiness"><summary><ShieldCheck size={15} />{setup?.ready ? 'Seu espaço passou pela conferência' : 'O que falta para publicar'}<ChevronDown size={15} /></summary><div className="feature-stack"><p className="muted">{setup?.next || 'Conferindo as etapas da sua instalação.'}</p>{error && <p role="alert" className="form-error">{error}</p>}{setup?.checks.map(check => <div className="overview-status" key={check.key}><div><b>{check.label}</b><p className="field-hint">{check.detail}</p></div><a className="text-link" href={`#${check.page}`} aria-label={`${check.label}: ${check.ready ? 'conferido' : 'ver configuração'}`}>{check.ready ? <Check size={15} /> : <ArrowRight size={15} />}</a></div>)}<Button variant="ghost" icon={RefreshCw} disabled={loading} onClick={() => void load()}>{loading ? 'Conferindo...' : 'Conferir novamente'}</Button></div></details>;
}

export function AffiliateFeaturesButton({ platform }: { platform: PlatformId }) {
  const [open, setOpen] = useState(false);
  return <><button className="marketplace-configure feature-store-button" onClick={() => setOpen(true)}><Link2 size={15} />Conta, guia e links por produto<ArrowRight size={15} /></button>{open && <AffiliateWorkspace platform={platform} onClose={() => setOpen(false)} />}</>;
}

function AffiliateWorkspace({ platform, onClose }: { platform: PlatformId; onClose: () => void }) {
  const demo = isDemonstration();
  const localCredentials = !demo && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
  const [guide, setGuide] = useState<IntegrationGuide | null>(null);
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [links, setLinks] = useState<ApprovedLink[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [originalUrl, setOriginalUrl] = useState('');
  const [affiliateUrl, setAffiliateUrl] = useState('');
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(false);
  const [sameProduct, setSameProduct] = useState(false);
  const [testUrl, setTestUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removeCredentials, setRemoveCredentials] = useState(false);
  const [removeLink, setRemoveLink] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const load = useCallback(async () => {
    const results = await Promise.allSettled([api.get<IntegrationGuide[]>('/affiliates/guides'), api.get<CredentialStatus[]>('/affiliates/credentials'), api.get<ApprovedLink[]>(`/affiliate-links?platform=${platform}`)]);
    if (!mounted.current) return;
    const [guides, credentials, library] = results;
    if (guides.status === 'fulfilled') setGuide(guides.value.find(item => item.platform === platform) || null);
    if (credentials.status === 'fulfilled') setCredential(credentials.value.find(item => item.platform === platform) || null);
    if (library.status === 'fulfilled') setLinks(library.value);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') setError(message(failed.reason));
    setLoading(false);
  }, [platform]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const credentialsSave = () => act(async () => {
    if (!localCredentials) throw new Error('Cadastre as chaves no painel do computador. Elas ficam no cofre local.');
    try { await api.post(`/affiliates/${platform}/credentials`, { values }); setNotice('Credenciais salvas no cofre local. Faça o teste para conferir o acesso.'); await load(); }
    finally { setValues({}); }
  });
  const importLink = () => act(async () => {
    if (!owner || !sameProduct) throw new Error('Confirme sua conta e o mesmo produto antes de salvar.');
    if (!safeUrl(originalUrl) || !safeUrl(affiliateUrl)) throw new Error('Informe dois links HTTPS válidos, sem usuário ou senha na URL.');
    await api.post('/affiliate-links', { platform, originalUrl: originalUrl.trim(), affiliateUrl: affiliateUrl.trim(), title: title.trim(), ownerConfirmed: true });
    setOriginalUrl(''); setAffiliateUrl(''); setTitle(''); setOwner(false); setSameProduct(false);
    setNotice(demo ? 'Par de links salvo somente neste navegador. Nenhuma afiliação real foi validada.' : 'Par de links salvo. A oferta desse produto ainda precisa da sua aprovação manual.');
    await load();
  });
  return <Modal title={`Sua parceria · ${platformNames[platform]}`} subtitle="Guia oficial, conexão e links do produto, reunidos aqui." onClose={onClose} wide><div className="feature-stack">
    {loading && <p role="status" className="muted"><LoaderCircle size={15} className="spin" /> Preparando suas opções...</p>}
    {error && <div className="notice notice-warning" role="alert">{error}</div>}{notice && <div className="notice notice-success" role="status">{notice}</div>}
    {guide && <details className="advanced-details" open><summary><ShieldCheck size={15} />Começar pelo programa oficial<ChevronDown size={15} /></summary><div className="feature-stack"><p className="muted">{guide.note}</p><ol className="feature-guide-steps">{guide.steps.map(step => <li key={step}>{step}</li>)}</ol><div className="feature-inline-actions">{safeUrl(guide.officialPortal) && <a className="text-link" href={guide.officialPortal} target="_blank" rel="noopener noreferrer">Abrir portal oficial<ExternalLink size={13} /></a>}{safeUrl(guide.documentationUrl) && <a className="text-link" href={guide.documentationUrl} target="_blank" rel="noopener noreferrer">Documentação oficial<ExternalLink size={13} /></a>}</div></div></details>}
    {guide && guide.fields.length > 0 && <details className="advanced-details"><summary><Link2 size={15} />Conectar conta no aplicativo local<Badge tone={credential?.configured ? 'green' : 'neutral'}>{credential?.configured ? 'Credenciais salvas' : 'A configurar'}</Badge><ChevronDown size={15} /></summary><form className="feature-stack" autoComplete="off" onSubmit={event => { event.preventDefault(); void credentialsSave(); }}>{!localCredentials && <div className="notice notice-subtle"><ShieldCheck size={17} /><p>Cadastre as chaves no painel do seu computador. Depois de pareá-lo com sua conta, as conexões ficam disponíveis aqui.</p></div>}<p className="field-hint">Use as chaves do programa de afiliados. Nunca informe sua senha da loja, SMS ou código de autenticação. Os valores salvos não são exibidos novamente.</p>{guide.fields.map(field => <Field key={field.key} label={field.label} hint={field.hint}><input aria-label={field.label} name={`affiliate-${platform}-${field.key}`} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} maxLength={2048} disabled={!localCredentials || busy} required={field.required && !credential?.configured} value={!localCredentials ? '' : values[field.key] || ''} placeholder={!localCredentials ? 'Disponível no aplicativo local' : credential?.fields.includes(field.key) ? 'Salvo · preencha para substituir' : ''} onChange={event => setValues(previous => ({ ...previous, [field.key]: event.target.value }))} /></Field>)}<div className="feature-inline-actions"><Button type="submit" icon={Check} disabled={!localCredentials || busy || !Object.values(values).some(value => value.trim())}>Salvar no cofre local</Button>{credential?.configured && <Button variant="ghost" icon={Trash2} disabled={!localCredentials || busy} onClick={() => setRemoveCredentials(true)}>Remover credenciais</Button>}</div><Field label="Produto para testar a conexão" hint="Use o link original de um produto desta loja. O teste não envia mensagem ao WhatsApp."><input type="url" aria-label="Produto para testar a conexão" value={testUrl} disabled={!localCredentials || busy} maxLength={2048} placeholder="https://..." onChange={event => setTestUrl(event.target.value)} /></Field><Button variant="secondary" icon={RefreshCw} disabled={!localCredentials || busy || !credential?.configured} onClick={() => void act(async () => { const result = await api.post<{ valid: boolean; reason: string }>(`/affiliates/${platform}/test`, testUrl.trim() ? { originalUrl: testUrl.trim() } : {}); if (!result.valid) throw new Error(result.reason); setNotice(result.reason); })}>Testar conexão</Button></form></details>}
    <section className="feature-stack"><SectionTitle title="Seus links por produto" description="Gere no portal oficial e guarde o par exato. Essa biblioteca pede revisão manual em cada oferta." action={<Badge>{links.length}</Badge>} />{demo && <div className="notice notice-subtle"><ShieldCheck size={17} /><p>Biblioteca de demonstração: os pares ficam neste navegador e não comprovam comissão ou titularidade.</p></div>}<details className="advanced-details"><summary><Plus size={15} />Adicionar um link oficial<ChevronDown size={15} /></summary><form className="feature-stack" onSubmit={event => { event.preventDefault(); void importLink(); }}><Field label="Nome para encontrar depois (opcional)"><input aria-label="Nome do link na biblioteca" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></Field><Field label="Link original do produto"><input type="url" aria-label="Produto original da biblioteca" required value={originalUrl} maxLength={2048} placeholder="https://..." onChange={event => setOriginalUrl(event.target.value)} /></Field><Field label="Link afiliado gerado no programa oficial"><input type="url" aria-label="Link afiliado da biblioteca" required value={affiliateUrl} maxLength={2048} placeholder="https://..." onChange={event => setAffiliateUrl(event.target.value)} /></Field><label className="feature-confirm"><input type="checkbox" checked={owner} onChange={event => setOwner(event.target.checked)} /><span>Gerei este link na minha própria conta do programa oficial.</span></label><label className="feature-confirm"><input type="checkbox" checked={sameProduct} onChange={event => setSameProduct(event.target.checked)} /><span>Conferi que os dois links levam ao mesmo produto, incluindo sua variação.</span></label><p className="field-hint">Links de campanha, vitrine, cupom genérico ou outro produto não devem ser usados aqui.</p><Button type="submit" icon={Plus} disabled={busy || !owner || !sameProduct || !originalUrl.trim() || !affiliateUrl.trim()}>Salvar par de links</Button></form></details>{links.length ? <div className="feature-link-list">{links.map(link => <div className="feature-link-row" key={link.id}><div><b>{link.title || link.productKey}</b><p title={link.originalUrl}>{link.originalUrl}</p><small title={link.affiliateUrl}>{link.affiliateUrl}</small><span className="field-hint">Titularidade declarada · aprovação manual</span></div><button className="icon-button" disabled={busy} aria-label={`Remover link ${link.title || link.productKey}`} onClick={() => setRemoveLink(link.id)}><Trash2 size={16} /></button></div>)}</div> : !loading && <EmptyState compact icon={Link2} title="Um produto, um link seu" description="Guarde links gerados no programa oficial para os produtos que você vai compartilhar." />}<Button variant="ghost" icon={Download} disabled={busy || !links.length} onClick={() => void act(async () => { const data = await api.get<unknown>('/affiliate-links/export'); downloadJson(data, `promobridge-links-${demo ? 'demo-' : ''}${new Date().toISOString().slice(0, 10)}.json`); setNotice('Biblioteca exportada. Credenciais e recibos ficam fora deste arquivo.'); })}>Exportar biblioteca</Button></section>
  </div><div className="modal-footer"><Button variant="secondary" onClick={onClose}>Fechar</Button></div>{removeCredentials && <Modal title="Remover as credenciais?" subtitle="As próximas conversões pela API vão precisar de uma nova configuração." onClose={() => setRemoveCredentials(false)}><div className="modal-footer"><Button variant="secondary" onClick={() => setRemoveCredentials(false)}>Cancelar</Button><Button variant="danger" disabled={busy} onClick={() => void act(async () => { await api.delete(`/affiliates/${platform}/credentials`); setValues({}); setRemoveCredentials(false); setNotice('Credenciais removidas do cofre local.'); await load(); })}>Remover credenciais</Button></div></Modal>}{removeLink && <Modal title="Remover este par de links?" subtitle="Este produto deixará de usar o link salvo nas próximas conversões." onClose={() => setRemoveLink(null)}><div className="modal-footer"><Button variant="secondary" onClick={() => setRemoveLink(null)}>Cancelar</Button><Button variant="danger" disabled={busy} onClick={() => void act(async () => { await api.delete(`/affiliate-links/${removeLink}`); setRemoveLink(null); setNotice('Par de links removido.'); await load(); })}>Remover link</Button></div></Modal>}</Modal>;
}

export function ManualOfferModal({ onClose, onIngest, onOpen, busy }: { onClose: () => void; onIngest: (text: string) => Promise<Offer[]>; onOpen: (offer: Offer) => void; busy: boolean }) {
  const [text, setText] = useState('');
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState('');
  const submit = async () => { setError(''); try { const result = await onIngest(text); setOffers(result); if (!result.length) setError('Não encontramos um produto. Confira o link e tente novamente.'); } catch (reason) { setError(message(reason)); } };
  return <Modal title="Adicionar uma oferta" subtitle={isDemonstration() ? 'Demonstração · A oferta será apenas simulada neste navegador.' : 'Uma entrada real, com sua revisão antes de qualquer envio.'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void submit(); }} className="feature-stack"><Field label="Texto e link do produto" hint="Inclua o preço e o cupom quando existirem. A oferta sempre entra para revisão."><textarea aria-label="Mensagem da oferta manual" rows={8} required maxLength={16000} value={text} onChange={event => { setText(event.target.value); setOffers(null); }} placeholder="Cole a oferta com o link original do produto..." /></Field>{error && <div className="notice notice-warning" role="alert">{error}</div>}{offers && offers.length > 0 && <div className="feature-stack"><div className="notice notice-success" role="status">{offers.length} oferta(s) preparada(s). Nenhuma mensagem enviada.</div>{offers.map(offer => <button type="button" className="store-status-row" key={offer.id} onClick={() => onOpen(offer)}><b>{offer.title}</b><ArrowRight size={15} /></button>)}</div>}<div className="modal-footer"><Button variant="secondary" onClick={onClose}>Fechar</Button><Button type="submit" icon={busy ? LoaderCircle : Plus} disabled={busy || !text.trim()}>{busy ? 'Preparando...' : isDemonstration() ? 'Adicionar à demonstração' : 'Adicionar para revisão'}</Button></div></form></Modal>;
}

function localDate(value: string | null | undefined) { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
export function OfferTools({ offer, busy, onUpdate }: { offer: Offer; busy: boolean; onUpdate: (path: string, body: unknown, success: string) => Promise<void> }) {
  const [title, setTitle] = useState(offer.title);
  const [price, setPrice] = useState(offer.price?.toString() || '');
  const [previousPrice, setPreviousPrice] = useState(offer.previousPrice?.toString() || '');
  const [coupon, setCoupon] = useState(offer.coupon || '');
  const [category, setCategory] = useState<CategoryId>(offer.category);
  const [expiry, setExpiry] = useState(localDate(offer.expiresAt));
  const [schedule, setSchedule] = useState(localDate(offer.scheduledAt));
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<'published' | 'not_sent' | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const terminal = ['published', 'publishing', 'uncertain', 'rejected', 'duplicate'].includes(offer.status);
  async function update(path: string, body: unknown, success: string) { setError(''); try { await onUpdate(`/offers/${offer.id}/${path}`, body, success); } catch (reason) { setError(message(reason)); } }
  const detailsSave = async () => {
    const amounts = [price, previousPrice].map(value => value.trim() === '' ? null : Number(value.replace(',', '.')));
    if (amounts.some(value => value !== null && (!Number.isFinite(value) || value <= 0))) { setError('Use preços maiores que zero, ou deixe em branco se não foram informados.'); return; }
    if (expiry && new Date(expiry).getTime() <= Date.now()) { setError('A validade precisa ser uma data futura.'); return; }
    if (!title.trim()) { setError('Informe o nome do produto.'); return; }
    await update('details', { title: title.trim(), price: amounts[0], previousPrice: amounts[1], coupon: coupon.trim() || null, category, expiresAt: expiry ? new Date(expiry).toISOString() : null }, 'Dados corrigidos. Score, mensagem e afiliação foram conferidos novamente.');
  };
  return <div className="feature-stack offer-feature-tools">{offer.requiresManualApproval && !offer.simulation && <div className="notice notice-subtle"><ShieldCheck size={16} /><p>Esta oferta exige sua aprovação manual, inclusive quando o modo automático está ativo.</p></div>}{offer.scheduledAt && <p className="small-note"><CalendarClock size={14} />Agendada para {new Date(offer.scheduledAt).toLocaleString('pt-BR')}, no fuso deste dispositivo.</p>}{offer.expiresAt && <p className="small-note">Válida até {new Date(offer.expiresAt).toLocaleString('pt-BR')}, no fuso deste dispositivo.</p>}{error && <div className="notice notice-warning" role="alert">{error}</div>}
    {offer.status === 'uncertain' ? <details className="advanced-details" open><summary><ShieldCheck size={15} />Conferir um envio sem confirmação<ChevronDown size={15} /></summary><div className="feature-stack"><p className="muted">Confira diretamente no grupo de destino se a mensagem chegou. Essa etapa não reenvia a oferta.</p>{offer.providerMessageId && <p className="field-hint">Referência: {offer.providerMessageId}</p>}<Field label="O que você encontrou no grupo?"><select aria-label="Resultado conferido do envio" value={outcome} onChange={event => { setOutcome(event.target.value as typeof outcome); setConfirmed(false); }}><option value="">Escolha após conferir</option><option value="published">A mensagem foi publicada</option><option value="not_sent">A mensagem não foi enviada</option></select></Field><label className="feature-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Conferi o grupo de destino e confirmo este resultado.</span></label><Button variant="secondary" icon={Check} disabled={busy || !confirmed || !outcome} onClick={() => void update('reconcile', { outcome, confirmed: true }, outcome === 'published' ? 'Publicação registrada após sua conferência.' : 'Oferta voltou à revisão. Nenhum reenvio foi feito.')}>Registrar conferência</Button></div></details> : <>
      <details className="advanced-details"><summary><Pencil size={15} />Corrigir dados da oferta<ChevronDown size={15} /></summary><form className="feature-stack" onSubmit={event => { event.preventDefault(); void detailsSave(); }}><Field label="Nome do produto"><input aria-label="Nome corrigido do produto" required maxLength={500} disabled={busy || terminal} value={title} onChange={event => setTitle(event.target.value)} /></Field><div className="form-row"><Field label="Preço atual (R$)"><input aria-label="Preço atual corrigido" type="number" min="0.01" step="0.01" disabled={busy || terminal} value={price} onChange={event => setPrice(event.target.value)} /></Field><Field label="Preço anterior (R$)"><input aria-label="Preço anterior corrigido" type="number" min="0.01" step="0.01" disabled={busy || terminal} value={previousPrice} onChange={event => setPreviousPrice(event.target.value)} /></Field></div><div className="form-row"><Field label="Cupom"><input aria-label="Cupom corrigido" maxLength={100} disabled={busy || terminal} value={coupon} onChange={event => setCoupon(event.target.value)} /></Field><Field label="Categoria"><select aria-label="Categoria corrigida" disabled={busy || terminal} value={category} onChange={event => setCategory(event.target.value as CategoryId)}>{categoryIds.map(id => <option key={id} value={id}>{categoryNames[id]}</option>)}</select></Field></div><Field label="Validade informada da oferta (opcional)" hint="Data e hora no fuso deste dispositivo. A oferta não será enviada após esse momento."><input aria-label="Validade da oferta" type="datetime-local" disabled={busy || terminal} value={expiry} onChange={event => setExpiry(event.target.value)} /></Field><p className="field-hint">Ao corrigir os dados, a aprovação anterior é revista e a mensagem é gerada novamente.</p><Button type="submit" variant="secondary" icon={Check} disabled={busy || terminal}>Salvar e reavaliar</Button></form></details>
      <details className="advanced-details"><summary><RefreshCw size={15} />Reavaliar e agendar<ChevronDown size={15} /></summary><div className="feature-stack"><p className="field-hint">Após configurar uma loja ou importar o link deste produto, refaça a análise para aplicar a mudança.</p><Button variant="secondary" icon={RefreshCw} disabled={busy || terminal} onClick={() => void update('reprocess', {}, 'Oferta reprocessada com suas configurações atuais.')}>Reprocessar oferta</Button><Field label="Publicar a partir de" hint="Data e hora no fuso deste dispositivo. O envio respeita silêncio, limites e validade."><input aria-label="Agendar publicação da oferta" type="datetime-local" disabled={busy || offer.status !== 'approved' || offer.simulation} value={schedule} onChange={event => setSchedule(event.target.value)} /></Field><Button variant="secondary" icon={CalendarClock} disabled={busy || offer.status !== 'approved' || offer.simulation || !schedule} onClick={() => { if (!schedule || new Date(schedule).getTime() <= Date.now()) { setError('Escolha uma data e hora futuras para agendar.'); return; } if (offer.expiresAt && new Date(schedule).getTime() >= new Date(offer.expiresAt).getTime()) { setError('Agende antes da validade da oferta.'); return; } void update('schedule', { scheduledAt: new Date(schedule).toISOString() }, 'Agendamento salvo. Todas as regras serão conferidas antes do envio.'); }}>Salvar agendamento</Button>{offer.status !== 'approved' && <p className="field-hint">Aprove a oferta para liberar o agendamento.</p>}{offer.simulation && <p className="field-hint">Simulações não podem agendar ou enviar mensagens reais.</p>}</div></details>
    </>}
  </div>;
}
