import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookmarkPlus, CalendarClock, Check, CheckCheck, ClipboardCheck, Copy, ExternalLink, History, KeyRound, Link2, ListChecks, LoaderCircle, Megaphone, Newspaper, Pause, PenLine, Play, Plus, RefreshCw, RotateCcw, Rss, Send, Settings2, ShieldCheck, Trash2, Upload, X, type LucideIcon } from 'lucide-react';
import {
  channelModeNames, channelRoleNames, checkChannelPost, defaultEditorialProfile, postStatusNames,
  type AiStatus, type Channel, type ChannelEvent, type ChannelPost, type ChannelsOverview, type EditorialProfile, type NewsItem, type NewsSource, type PostInput, type PostKind, type PostStatus, type PostTemplate,
} from '../../../packages/shared/src/channels.ts';
import { api } from './api.ts';
import { PageIntro } from './Settings.tsx';
import { Badge, Button, EmptyState, Field, Modal, SectionTitle, Toggle, timeAgo } from './ui.tsx';
import './channels.css';

type Tab = 'channels' | 'connections' | 'posts' | 'create' | 'news' | 'schedule' | 'queue' | 'history' | 'settings';
type ListedChannel = ChannelsOverview['channels'][number];
const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'channels', label: 'Meus canais', icon: Megaphone }, { id: 'connections', label: 'Conexões', icon: Link2 },
  { id: 'posts', label: 'Publicações', icon: ListChecks }, { id: 'create', label: 'Criar conteúdo', icon: PenLine },
  { id: 'news', label: 'Notícias e curadoria', icon: Newspaper }, { id: 'schedule', label: 'Agendamentos', icon: CalendarClock },
  { id: 'queue', label: 'Fila de aprovação', icon: ClipboardCheck }, { id: 'history', label: 'Histórico e resultados', icon: History },
  { id: 'settings', label: 'Configurações', icon: Settings2 },
];
const tone: Record<PostStatus, 'neutral' | 'green' | 'amber' | 'purple' | 'red'> = { draft: 'neutral', review: 'amber', approved: 'purple', scheduled: 'purple', sending: 'amber', pending_confirmation: 'amber', published: 'green', rejected: 'red', cancelled: 'neutral', failed: 'red', expired: 'neutral' };
const kinds: { id: PostKind; label: string }[] = [{ id: 'text', label: 'Texto' }, { id: 'image', label: 'Imagem' }, { id: 'video', label: 'Vídeo' }, { id: 'audio', label: 'Áudio' }, { id: 'poll', label: 'Enquete' }];
const accept: Record<'image' | 'video' | 'audio', string> = { image: 'image/jpeg,image/png,image/webp', video: 'video/mp4', audio: 'audio/mpeg,audio/ogg,audio/mp4,.m4a' };
const emojis = ['📰', '📌', '✅', '⚠️', '💡', '📅', '👉', '🔎', '✨', '🙏'];
const emptyInput = (): PostInput => ({ kind: 'text', title: '', subtitle: '', body: '', linkUrl: '', includeSignature: true, mediaId: null, priority: 'normal' });
const fmt = (value: string | null) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const message = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível concluir esta ação.';
const firstLine = (post: ChannelPost) => post.title || post.body.split('\n')[0] || post.mediaName || 'Publicação sem título';
const toLocalInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ChannelsPage({ notify, onGoSources }: { notify: (text: string, error?: boolean) => void; onGoSources: () => void }) {
  const [overview, setOverview] = useState<ChannelsOverview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('channels');
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ChannelPost | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const channel = overview?.channels.find(item => item.id === selectedId) ?? overview?.channels[0] ?? null;

  const refresh = useCallback(async () => {
    const next = await api.get<ChannelsOverview>('/channels');
    setOverview(next); setLoadError('');
    const current = next.channels.find(item => item.id === selectedId) ?? next.channels[0];
    setPosts(current && next.available ? await api.get<ChannelPost[]>(`/channels/${current.id}/posts`) : []);
  }, [selectedId]);
  useEffect(() => { void refresh().catch(error => setLoadError(message(error))); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!busyRef.current && document.visibilityState === 'visible') void refresh().catch(() => undefined); }, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const act = async <T,>(operation: () => Promise<T>, success?: string): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true; setBusy(true);
    try { const result = await operation(); await refresh(); if (success) notify(success); return result; }
    catch (error) { notify(message(error), true); return undefined; }
    finally { busyRef.current = false; setBusy(false); }
  };

  if (!overview) return <><PageIntro eyebrow="CANAIS DO WHATSAPP" title="Seus canais" description="Prepare, revise, agende e publique conteúdos nos Canais que você administra." />{loadError ? <div className="notice notice-warning" role="alert"><AlertTriangle size={18} /><p>{loadError}</p><Button variant="ghost" icon={RefreshCw} onClick={() => void refresh().catch(error => setLoadError(message(error)))}>Tentar novamente</Button></div> : <div className="ch-loading" aria-busy="true"><LoaderCircle className="spin" size={20} /> Carregando seus canais…</div>}</>;
  const counts = (status: PostStatus) => posts.filter(post => post.status === status).length;
  const openEditor = (post: ChannelPost | null) => { setEditing(post); setTab('create'); };

  return <>
    <PageIntro eyebrow="CANAIS DO WHATSAPP" title="Seus canais" description="Prepare, revise, agende e publique nos Canais que você administra. Canais não são grupos: ficam na aba Atualizações do WhatsApp." action={overview.available ? <Button variant={overview.globalPause.paused ? 'primary' : 'secondary'} icon={overview.globalPause.paused ? Play : Pause} disabled={busy} onClick={() => void act(() => api.post('/channels/pause', { paused: !overview.globalPause.paused }), overview.globalPause.paused ? 'Canais retomados.' : 'Pausa geral ativada: nenhuma publicação sai.')}>{overview.globalPause.paused ? 'Retomar todos os canais' : 'Pausar todos os canais'}</Button> : undefined} />
    <div className="notice notice-subtle ch-engine" role="note"><ShieldCheck size={18} /><p><b>{overview.engine.connected ? 'WhatsApp conectado.' : 'WhatsApp desconectado.'}</b> {overview.engine.detail} A conexão por QR Code usa uma biblioteca do WhatsApp Web, <b>não é uma API oficial da Meta</b> e pode mudar ou sofrer restrições. A Meta não oferece hoje uma API oficial para publicar em Canais.</p></div>
    {overview.globalPause.paused && <div className="notice notice-warning" role="alert"><Pause size={18} /><p><b>Pausa geral ativa.</b> {overview.globalPause.reason}</p></div>}
    {!overview.available ? <section className="panel settings-panel"><EmptyState icon={Megaphone} title="Os canais precisam do seu WhatsApp ligado" description={overview.engine.detail} action={<Button variant="secondary" onClick={onGoSources}>Ir para Fontes & conexões</Button>} /></section> : <>
      {overview.channels.length > 1 && <div className="ch-picker"><Field label="Canal em uso"><select aria-label="Canal em uso" value={channel?.id ?? ''} onChange={event => { setSelectedId(event.target.value); setEditing(null); }}>{overview.channels.map(item => <option key={item.id} value={item.id}>{item.name}{item.settings.paused ? ' (pausado)' : ''}</option>)}</select></Field></div>}
      <nav className="ch-tabs" aria-label="Áreas dos canais">{tabs.map(item => { const badge = item.id === 'queue' ? counts('review') : item.id === 'schedule' ? counts('scheduled') : 0; return <button key={item.id} className={`ch-tab ${tab === item.id ? 'active' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); if (item.id !== 'create') setEditing(null); }}><item.icon size={16} strokeWidth={1.8} /><span>{item.label}</span>{badge > 0 && <span className="nav-count">{badge}</span>}</button>; })}</nav>
      {tab === 'channels' && <MyChannels overview={overview} busy={busy} act={act} onSelect={id => { setSelectedId(id); setTab('posts'); }} />}
      {tab === 'connections' && <Connections overview={overview} busy={busy} act={act} onGoSources={onGoSources} />}
      {!channel && !['channels', 'connections'].includes(tab) && <section className="panel settings-panel"><EmptyState icon={Megaphone} title="Vincule um canal primeiro" description="Use o link público do canal que você administra, em Meus canais." action={<Button variant="secondary" onClick={() => setTab('channels')}>Vincular canal</Button>} /></section>}
      {channel && tab === 'posts' && <PostList title="Publicações" description="Tudo o que foi preparado para este canal." posts={posts} onOpen={post => setDetailId(post.id)} onNew={() => openEditor(null)} />}
      {channel && tab === 'create' && <Editor key={`${channel.id}-${editing?.id ?? 'new'}`} channel={channel} post={editing} busy={busy} act={act} onDone={post => { setEditing(null); setDetailId(post.id); setTab('posts'); }} />}
      {channel && tab === 'queue' && <PostList title="Fila de aprovação" description="Conteúdos esperando o seu olhar antes de seguir." posts={posts.filter(post => post.status === 'review')} onOpen={post => setDetailId(post.id)} empty="Nada esperando aprovação agora." />}
      {channel && tab === 'schedule' && <PostList title="Agendamentos" description="Aprovados e agendados. O envio respeita horários, intervalos e limites do canal." posts={posts.filter(post => ['approved', 'scheduled', 'sending'].includes(post.status)).sort((a, b) => (a.scheduledAt ?? '9').localeCompare(b.scheduledAt ?? '9'))} onOpen={post => setDetailId(post.id)} empty="Nenhuma publicação aprovada ou agendada." />}
      {channel && tab === 'history' && <HistoryView channel={channel} posts={posts} onOpen={post => setDetailId(post.id)} />}
      {channel && tab === 'news' && <NewsView key={channel.id} channel={channel} busy={busy} act={act} onOpenPost={id => setDetailId(id)} />}
      {channel && tab === 'settings' && <ChannelSettingsView key={channel.id} channel={channel} busy={busy} act={act} />}
    </>}
    {detailId && channel && <PostDetail channel={channel} postId={detailId} busy={busy} act={act} onClose={() => setDetailId(null)} onEdit={post => { setDetailId(null); openEditor(post); }} />}
  </>;
}

type Act = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;

function AutomaticBadge({ channel }: { channel: ListedChannel }) {
  return channel.automaticPublishing === 'available' ? <Badge tone="green" dot>Publicação automática disponível</Badge> : <Badge tone="amber" dot>Publicação automática indisponível</Badge>;
}

function MyChannels({ overview, busy, act, onSelect }: { overview: ChannelsOverview; busy: boolean; act: Act; onSelect: (id: string) => void }) {
  const [reference, setReference] = useState('');
  const [purpose, setPurpose] = useState<'editorial' | 'promotions'>('editorial');
  const [confirmUnlink, setConfirmUnlink] = useState<ListedChannel | null>(null);
  return <div className="settings-grid ch-grid">
    <section className="panel settings-panel"><SectionTitle title="Canais vinculados" description="Só canais em que o número conectado é proprietário ou administrador podem publicar." action={<Badge>{overview.channels.length}</Badge>} />
      {overview.channels.length ? <div className="ch-cards">{overview.channels.map(channel => <article className="ch-card" key={channel.id}>
        <div className="ch-card-head"><span className="ch-avatar"><Megaphone size={18} /></span><div><b>{channel.name}</b><small>{channelRoleNames[channel.role]} · {channel.purpose === 'promotions' ? 'Canal de promoções' : 'Canal editorial'} · Modo {channelModeNames[channel.settings.mode].toLowerCase()}</small></div></div>
        <div className="ch-badges">{channel.settings.paused ? <Badge tone="red" dot>Pausado</Badge> : <Badge tone="green" dot>Ativo</Badge>}<AutomaticBadge channel={channel} />{(channel.counts.review ?? 0) > 0 && <Badge tone="amber">{channel.counts.review} na fila</Badge>}</div>
        {channel.pausedReason && <p className="ch-alert"><AlertTriangle size={14} /> {channel.pausedReason}</p>}
        {channel.automaticPublishing !== 'available' && <p className="small-note">{channel.automaticDetail}</p>}
        <div className="ch-actions"><Button variant="secondary" onClick={() => onSelect(channel.id)}>Abrir publicações</Button><Button variant="ghost" icon={channel.settings.paused ? Play : Pause} disabled={busy} onClick={() => void act(() => api.post(`/channels/${channel.id}/pause`, { paused: !channel.settings.paused }), channel.settings.paused ? 'Canal retomado.' : 'Canal pausado imediatamente.')}>{channel.settings.paused ? 'Retomar' : 'Pausar agora'}</Button>{channel.publicUrl && <a className="button button-ghost" href={channel.publicUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Abrir no WhatsApp</a>}<Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => setConfirmUnlink(channel)}>Desvincular</Button></div>
      </article>)}</div> : <EmptyState compact icon={Megaphone} title="Nenhum canal vinculado" description="Cole ao lado o link público de um canal que você administra." />}
    </section>
    <section className="panel settings-panel"><SectionTitle title="Vincular um canal" description="O app confere no WhatsApp se o número conectado administra o canal. Seguir um canal não basta." />
      <Field label="Link público ou identificador do canal" hint="Ex.: https://whatsapp.com/channel/0029Va… ou 1203…@newsletter. Grupos não são aceitos aqui."><input aria-label="Link do canal" value={reference} maxLength={300} placeholder="https://whatsapp.com/channel/…" onChange={event => setReference(event.target.value)} /></Field>
      <Field label="Finalidade do canal" hint="Notícias nunca vão para um canal de promoções, e promoções nunca vão automaticamente para um canal editorial."><select aria-label="Finalidade do canal" value={purpose} onChange={event => setPurpose(event.target.value as 'editorial' | 'promotions')}><option value="editorial">Editorial (conteúdo, avisos, notícias)</option><option value="promotions">Promoções</option></select></Field>
      <Button icon={busy ? LoaderCircle : Plus} disabled={busy || !reference.trim() || !overview.engine.connected} onClick={() => void act(() => api.post('/channels', { reference: reference.trim(), purpose }), 'Canal vinculado.').then(result => { if (result) setReference(''); })}>Conferir e vincular</Button>
      {!overview.engine.connected && <p className="small-note"><AlertTriangle size={13} /> Conecte o WhatsApp para conferir a permissão no canal.</p>}
    </section>
    {confirmUnlink && <Modal title="Desvincular este canal do app?" subtitle="Nada muda no WhatsApp: o canal continua existindo. Rascunhos e agendamentos dele são cancelados; o histórico fica guardado." onClose={() => setConfirmUnlink(null)}><div className="modal-footer"><Button variant="secondary" onClick={() => setConfirmUnlink(null)}>Manter</Button><Button variant="danger" onClick={() => { const target = confirmUnlink; setConfirmUnlink(null); void act(() => api.delete(`/channels/${target.id}`), 'Canal desvinculado do app.'); }}>Desvincular</Button></div></Modal>}
  </div>;
}

function Connections({ overview, busy, act, onGoSources }: { overview: ChannelsOverview; busy: boolean; act: Act; onGoSources: () => void }) {
  return <section className="panel settings-panel"><SectionTitle title="Conexões" description="Os canais usam o mesmo WhatsApp conectado em Fontes & conexões, por um adaptador separado do envio para grupos." action={<Badge tone={overview.engine.connected ? 'green' : 'neutral'} dot>{overview.engine.connected ? 'Conectado' : 'Desconectado'}</Badge>} />
    <div className="ch-rows">{overview.channels.map(channel => <div className="ch-row" key={channel.id}><div><b>{channel.name}</b><small>{channelRoleNames[channel.role]} · conferido {channel.roleCheckedAt ? timeAgo(channel.roleCheckedAt) : 'nunca'} · {channel.subscribers ?? '—'} seguidores</small><small className="ch-mono">{channel.jid}</small></div><Button variant="ghost" icon={RefreshCw} disabled={busy || !overview.engine.connected} onClick={() => void act(() => api.post(`/channels/${channel.id}/refresh`), 'Permissão conferida no WhatsApp.')}>Conferir permissão</Button></div>)}</div>
    {!overview.channels.length && <p className="muted">Vincule um canal em Meus canais para ver a permissão dele aqui.</p>}
    <div className="ch-actions"><Button variant="secondary" onClick={onGoSources}>Gerenciar a conexão do WhatsApp</Button></div>
  </section>;
}

function PostList({ title, description, posts, onOpen, onNew, empty = 'Nenhuma publicação ainda.' }: { title: string; description: string; posts: ChannelPost[]; onOpen: (post: ChannelPost) => void; onNew?: () => void; empty?: string }) {
  const [filter, setFilter] = useState<PostStatus | 'all'>('all');
  const statuses = useMemo(() => [...new Set(posts.map(post => post.status))], [posts]);
  const visible = filter === 'all' ? posts : posts.filter(post => post.status === filter);
  return <section className="panel settings-panel"><SectionTitle title={title} description={description} action={onNew && <Button icon={Plus} onClick={onNew}>Nova publicação</Button>} />
    {statuses.length > 1 && <div className="ch-filters" role="group" aria-label="Filtrar por estado"><button className={`example-chip ${filter === 'all' ? 'selected' : ''}`} onClick={() => setFilter('all')}>Todas</button>{statuses.map(status => <button key={status} className={`example-chip ${filter === status ? 'selected' : ''}`} onClick={() => setFilter(status)}>{postStatusNames[status]}</button>)}</div>}
    {visible.length ? <div className="ch-rows">{visible.map(post => <button className="ch-row ch-post" key={post.id} onClick={() => onOpen(post)}><div><b>{firstLine(post)}</b><small>{post.origin === 'news' ? 'Notícia · ' : ''}{post.kind !== 'text' ? `${kinds.find(kind => kind.id === post.kind)?.label} · ` : ''}{post.scheduledAt && ['scheduled', 'approved'].includes(post.status) ? `para ${fmt(post.scheduledAt)}` : `atualizado ${timeAgo(post.updatedAt)}`}{post.priority === 'urgent' ? ' · urgente' : ''}</small>{post.lastError && <small className="ch-error">{post.lastError}</small>}</div><Badge tone={tone[post.status]}>{postStatusNames[post.status]}</Badge></button>)}</div> : <p className="muted">{empty}</p>}
  </section>;
}

function Preview({ text, post }: { text: string; post: Pick<ChannelPost, 'kind' | 'mediaId' | 'mediaMime' | 'mediaName'> }) {
  return <div className="panel message-live-preview ch-preview"><div className="preview-title"><Send size={16} /> Como vai aparecer no canal <Badge>Prévia exata</Badge></div><div className="phone-preview"><div className="phone-preview-header"><span className="group-avatar"><Megaphone size={16} /></span><div><b>Seu canal</b><span>Atualizações</span></div></div><div className="whatsapp-bubble">
    {post.mediaId && post.kind === 'image' && <img className="ch-media" src={`/api/v1/channels/media/${post.mediaId}`} alt="Imagem da publicação" />}
    {post.mediaId && post.kind === 'video' && <p className="ch-media-file">🎬 {post.mediaName ?? 'vídeo'}</p>}
    {post.mediaId && post.kind === 'audio' && <p className="ch-media-file">🎧 {post.mediaName ?? 'áudio'}</p>}
    <p>{text ? formatWhatsApp(text) : <span className="muted">A mensagem aparece aqui enquanto você escreve.</span>}</p></div></div></div>;
}
/** Shows *bold* and _italic_ the way WhatsApp does, without injecting HTML. */
function formatWhatsApp(text: string) {
  return text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((part, index) => part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <b key={index}>{part.slice(1, -1)}</b> : part.startsWith('_') && part.endsWith('_') && part.length > 2 ? <i key={index}>{part.slice(1, -1)}</i> : part);
}

function Editor({ channel, post, busy, act, onDone }: { channel: ListedChannel; post: ChannelPost | null; busy: boolean; act: Act; onDone: (post: ChannelPost) => void }) {
  const [input, setInput] = useState<PostInput>(post ? { kind: post.kind, title: post.title, subtitle: post.subtitle, body: post.body, linkUrl: post.linkUrl, includeSignature: post.includeSignature, mediaId: post.mediaId, priority: post.priority } : emptyInput());
  const [media, setMedia] = useState<{ mime: string | null; bytes: number | null; name: string | null }>({ mime: post?.mediaMime ?? null, bytes: post?.mediaBytes ?? null, name: post?.mediaName ?? null });
  const [templates, setTemplates] = useState<PostTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [uploading, setUploading] = useState(false);
  useEffect(() => { void api.get<PostTemplate[]>('/channels/templates').then(setTemplates).catch(() => setTemplates([])); }, []);
  const shape = { ...input, mediaMime: media.mime, mediaBytes: media.bytes };
  const check = checkChannelPost(shape, channel.settings);
  const change = (patch: Partial<PostInput>) => setInput(current => ({ ...current, ...patch }));
  const upload = async (file: File) => {
    if (input.kind === 'text' || input.kind === 'poll') return;
    if (file.size > 3 * 1024 * 1024) { await act(() => Promise.reject(new Error('O arquivo deve ter até 3 MB.'))); return; }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.')); reader.readAsDataURL(file); });
      const saved = await act(() => api.post<{ id: string; mime: string; bytes: number; name: string }>('/channels/media', { kind: input.kind, name: file.name, base64 }), 'Arquivo pronto para a publicação.');
      if (saved) { change({ mediaId: saved.id }); setMedia({ mime: saved.mime, bytes: saved.bytes, name: saved.name }); }
    } finally { setUploading(false); }
  };
  const save = async (submit: boolean) => {
    const saved = await act(() => post ? api.put<ChannelPost>(`/channels/${channel.id}/posts/${post.id}`, input) : api.post<ChannelPost>(`/channels/${channel.id}/posts`, input), submit ? undefined : 'Rascunho salvo.');
    if (!saved) return;
    if (submit) { const sent = await act(() => api.post<ChannelPost>(`/channels/${channel.id}/posts/${saved.id}/action`, { action: 'submit' }), 'Enviado para a fila de aprovação.'); onDone(sent ?? saved); }
    else onDone(saved);
  };
  return <div className="settings-grid message-settings-grid ch-editor">
    <section className="panel settings-panel"><SectionTitle title={post ? 'Editar publicação' : 'Nova publicação'} description={post ? 'Editar remove a aprovação anterior; a publicação volta para rascunho.' : `Para o canal ${channel.name}.`} />
      <div className="ch-kinds" role="group" aria-label="Tipo de publicação">{kinds.map(kind => { const unsupported = kind.id === 'poll'; return <button key={kind.id} type="button" aria-pressed={input.kind === kind.id} disabled={unsupported} title={kind.id === 'poll' ? 'Enquetes em Canais não têm suporte comprovado neste motor.' : undefined} className={`example-chip ${input.kind === kind.id ? 'selected' : ''}`} onClick={() => { change({ kind: kind.id, mediaId: null }); setMedia({ mime: null, bytes: null, name: null }); }}>{kind.label}{kind.id === 'poll' && ' · indisponível'}</button>; })}</div>
      {templates.length > 0 && <Field label="Começar de um modelo"><select aria-label="Modelo" value="" onChange={event => { const template = templates.find(item => item.id === event.target.value); if (template) setInput(current => ({ ...current, ...template.content, mediaId: current.kind === template.content.kind ? current.mediaId : null })); }}><option value="">Escolha um modelo salvo</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field>}
      <Field label="Título (opcional)" hint="Aparece em negrito."><input aria-label="Título" maxLength={120} value={input.title} onChange={event => change({ title: event.target.value })} /></Field>
      <Field label="Subtítulo (opcional)" hint="Aparece em itálico."><input aria-label="Subtítulo" maxLength={160} value={input.subtitle} onChange={event => change({ subtitle: event.target.value })} /></Field>
      {input.kind !== 'audio' && <Field label={input.kind === 'text' ? 'Texto' : 'Legenda'} hint={`${check.text.length} de ${input.kind === 'text' ? 4096 : 1024} caracteres no texto final`}><textarea aria-label={input.kind === 'text' ? 'Texto da publicação' : 'Legenda'} rows={8} maxLength={4096} value={input.body} onChange={event => change({ body: event.target.value })} /></Field>}
      {input.kind !== 'audio' && <div className="ch-emojis" aria-label="Inserir emoji">{emojis.map(emoji => <button type="button" key={emoji} className="icon-button" aria-label={`Inserir ${emoji}`} onClick={() => change({ body: `${input.body}${emoji}` })}>{emoji}</button>)}</div>}
      {input.kind !== 'audio' && <Field label="Link (opcional)" hint="Somente HTTPS."><input aria-label="Link" inputMode="url" maxLength={2048} value={input.linkUrl} placeholder="https://" onChange={event => change({ linkUrl: event.target.value })} /></Field>}
      {(input.kind === 'image' || input.kind === 'video' || input.kind === 'audio') && <Field label="Arquivo" hint={input.kind === 'image' ? 'JPEG, PNG ou WebP até 3 MB.' : input.kind === 'video' ? 'MP4 até 3 MB.' : 'MP3, OGG ou M4A até 3 MB. Áudio não leva legenda.'}><label className="button button-secondary ch-upload"><Upload size={16} />{uploading ? 'Enviando…' : media.name ? `Trocar arquivo (${media.name})` : 'Escolher arquivo'}<input type="file" accept={accept[input.kind]} disabled={uploading || busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label></Field>}
      <Toggle label="Incluir assinatura do canal" description={channel.settings.signature ? channel.settings.signature : 'Defina a assinatura em Configurações.'} checked={input.includeSignature} onChange={value => change({ includeSignature: value })} />
      <Toggle label="Publicação urgente" description={`Ignora a janela de horário e o intervalo, dentro do limite de ${channel.settings.maxUrgentPerDay} por dia.`} checked={input.priority === 'urgent'} onChange={value => change({ priority: value ? 'urgent' : 'normal' })} />
      {check.errors.length > 0 && <div className="notice notice-warning" role="alert"><AlertTriangle size={17} /><p>{check.errors.join(' ')}</p></div>}
      {check.warnings.length > 0 && <div className="notice notice-subtle"><AlertTriangle size={17} /><p>{check.warnings.join(' ')}</p></div>}
      <div className="ch-actions"><Button variant="secondary" disabled={busy} onClick={() => void save(false)}>Salvar rascunho</Button><Button icon={busy ? LoaderCircle : Send} disabled={busy || check.errors.length > 0} onClick={() => void save(true)}>Salvar e enviar para revisão</Button></div>
      <div className="ch-template"><input aria-label="Nome do modelo" placeholder="Nome do modelo" maxLength={80} value={templateName} onChange={event => setTemplateName(event.target.value)} /><Button variant="ghost" icon={BookmarkPlus} disabled={busy || !templateName.trim() || input.kind === 'poll'} onClick={() => void act(() => api.post('/channels/templates', { name: templateName.trim(), content: { kind: input.kind, title: input.title, subtitle: input.subtitle, body: input.body, linkUrl: input.linkUrl, includeSignature: input.includeSignature } }), 'Modelo salvo.').then(() => { setTemplateName(''); void api.get<PostTemplate[]>('/channels/templates').then(setTemplates).catch(() => undefined); })}>Salvar como modelo</Button></div>
    </section>
    <Preview text={check.text} post={{ kind: input.kind, mediaId: input.mediaId, mediaMime: media.mime, mediaName: media.name }} />
  </div>;
}

function PostDetail({ channel, postId, busy, act, onClose, onEdit }: { channel: ListedChannel; postId: string; busy: boolean; act: Act; onClose: () => void; onEdit: (post: ChannelPost) => void }) {
  const [detail, setDetail] = useState<{ post: ChannelPost; preview: string; errors: string[]; warnings: string[]; blockers: string[]; events: ChannelEvent[] } | null>(null);
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
  const [confirm, setConfirm] = useState<'published' | 'not_sent' | 'manual' | null>(null);
  const load = useCallback(() => api.get<NonNullable<typeof detail>>(`/channels/${channel.id}/posts/${postId}`).then(setDetail), [channel.id, postId]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const action = (body: Record<string, unknown>, success: string) => void act(() => api.post(`/channels/${channel.id}/posts/${postId}/action`, body), success).then(() => load().catch(() => undefined));
  if (!detail) return <Modal title="Publicação" onClose={onClose}><div className="ch-loading"><LoaderCircle className="spin" size={18} /> Carregando…</div></Modal>;
  const post = detail.post, status = post.status;
  const copyAndOpen = async () => { try { await navigator.clipboard.writeText(detail.preview); } catch { /* the text stays visible to copy by hand */ } if (channel.publicUrl) window.open(channel.publicUrl, '_blank', 'noopener'); };
  return <Modal title={firstLine(post)} subtitle={`${postStatusNames[status]} · ${channel.name}`} onClose={onClose} wide><div className="offer-detail-grid ch-detail">
    <div>
      <div className="ch-badges"><Badge tone={tone[status]} dot>{postStatusNames[status]}</Badge>{post.priority === 'urgent' && <Badge tone="red">Urgente</Badge>}{post.origin === 'news' && <Badge tone="purple">Notícia</Badge>}{post.confirmation === 'automatic' && <Badge tone="green">Encontrada no canal pelo app</Badge>}{post.confirmation === 'owner' && <Badge tone="green">Confirmada por você</Badge>}{post.uncertain && <Badge tone="amber">Resultado incerto</Badge>}</div>
      {post.lastError && <div className="notice notice-warning"><AlertTriangle size={17} /><p>{post.lastError}</p></div>}
      {detail.errors.length > 0 && <div className="notice notice-warning"><AlertTriangle size={17} /><p>{detail.errors.join(' ')}</p></div>}
      {detail.blockers.length > 0 && <div className="notice notice-subtle"><CalendarClock size={17} /><p><b>Aguardando para sair:</b> {detail.blockers.join(' ')}</p></div>}
      {status === 'pending_confirmation' && <div className="notice notice-subtle"><ShieldCheck size={17} /><p>O WhatsApp aceitou o envio, mas aceitar não é o mesmo que publicar. O app confere o canal algumas vezes; você também pode abrir o canal e registrar o resultado. <b>Nada é reenviado automaticamente.</b></p></div>}
      <div className="ch-actions ch-wrap">
        {EDIT.includes(status) && <Button variant="secondary" icon={PenLine} disabled={busy} onClick={() => onEdit(post)}>Editar</Button>}
        {status === 'draft' && <Button icon={Send} disabled={busy} onClick={() => action({ action: 'submit' }, 'Enviado para revisão.')}>Enviar para revisão</Button>}
        {status === 'review' && <><Button icon={Check} disabled={busy} onClick={() => action({ action: 'approve' }, channel.settings.mode === 'manual' ? 'Aprovado.' : 'Aprovado e agendado para o próximo horário livre.')}>Aprovar</Button><Button variant="ghost" icon={X} disabled={busy} onClick={() => action({ action: 'reject' }, 'Rejeitado.')}>Rejeitar</Button></>}
        {(status === 'approved' || status === 'scheduled') && <>
          <Button icon={Send} disabled={busy || channel.automaticPublishing === 'unavailable'} title={channel.automaticPublishing === 'unavailable' ? channel.automaticDetail : undefined} onClick={() => action({ action: 'publish_now' }, 'Enviado. Conferindo se aparece no canal.')}>Publicar agora</Button>
          <span className="ch-schedule"><input type="datetime-local" aria-label="Data e hora do agendamento" value={when} onChange={event => setWhen(event.target.value)} /><Button variant="secondary" icon={CalendarClock} disabled={busy || !when} onClick={() => action({ action: 'schedule', scheduledAt: new Date(when).toISOString() }, 'Agendado.')}>Agendar</Button></span>
          <Button variant="ghost" disabled={busy} onClick={() => action({ action: 'schedule', scheduledAt: null }, 'Agendado para o próximo horário livre.')}>Próximo horário livre</Button>
          {status === 'scheduled' && <Button variant="ghost" disabled={busy} onClick={() => action({ action: 'unschedule' }, 'Agendamento removido.')}>Tirar da agenda</Button>}
          <Button variant="ghost" icon={Copy} onClick={() => void copyAndOpen()}>Copiar e abrir o canal</Button>
          <Button variant="ghost" icon={CheckCheck} disabled={busy} onClick={() => setConfirm('manual')}>Publiquei manualmente</Button>
        </>}
        {status === 'pending_confirmation' && <><Button icon={CheckCheck} disabled={busy} onClick={() => setConfirm('published')}>Apareceu no canal</Button><Button variant="ghost" icon={X} disabled={busy} onClick={() => setConfirm('not_sent')}>Não apareceu</Button>{channel.publicUrl && <a className="button button-ghost" href={channel.publicUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Abrir o canal</a>}</>}
        {['draft', 'review', 'approved', 'scheduled'].includes(status) && <Button variant="ghost" disabled={busy} onClick={() => action({ action: 'cancel' }, 'Cancelado.')}>Cancelar</Button>}
        {['rejected', 'cancelled', 'failed', 'expired'].includes(status) && <Button variant="secondary" icon={RotateCcw} disabled={busy} onClick={() => action({ action: 'reopen' }, 'Reaberto como rascunho.')}>Reabrir como rascunho</Button>}
        <Button variant="ghost" icon={Copy} disabled={busy} onClick={() => void act(() => api.post<ChannelPost>(`/channels/${channel.id}/posts/${postId}/duplicate`, {}), 'Cópia criada como rascunho.')}>Duplicar</Button>
        {['draft', 'rejected', 'cancelled', 'expired', 'failed'].includes(status) && !post.sendingAt && <Button variant="danger" icon={Trash2} disabled={busy} onClick={() => void act(() => api.delete(`/channels/${channel.id}/posts/${postId}`), 'Publicação excluída.').then(result => { if (result) onClose(); })}>Excluir</Button>}
      </div>
      <SectionTitle title="Histórico" description="Cada mudança de estado fica registrada." />
      <div className="timeline-list">{[...post.history].reverse().map((entry, index) => <div className="timeline-item" key={`${entry.at}-${index}`}><span className="timeline-icon"><Check size={12} /></span><div className="timeline-content"><p><b>{postStatusNames[entry.to]}</b> · {entry.note}</p><time>{fmt(entry.at)}</time></div></div>)}</div>
      <p className="small-note">Criado {fmt(post.createdAt)} · Agendado {fmt(post.scheduledAt)} · Enviado {fmt(post.sendingAt)} · Publicado {fmt(post.publishedAt)}{post.expiresAt ? ` · Válido até ${fmt(post.expiresAt)}` : ''}</p>
    </div>
    <Preview text={detail.preview} post={post} />
  </div>
  {confirm && <Modal title={confirm === 'published' ? 'A publicação apareceu no canal?' : confirm === 'not_sent' ? 'Confirmar que NÃO apareceu?' : 'Você publicou este texto manualmente?'} subtitle={confirm === 'published' ? 'Confira no WhatsApp antes. Isso também comprova que o envio real funciona neste canal.' : confirm === 'not_sent' ? 'A publicação fica marcada como falha. Nada é reenviado; você pode reabrir como rascunho.' : 'Use quando copiou o texto e publicou pelo próprio WhatsApp. O app não enviou nada.'} onClose={() => setConfirm(null)}><div className="modal-footer"><Button variant="secondary" onClick={() => setConfirm(null)}>Voltar</Button><Button onClick={() => { const choice = confirm; setConfirm(null); action(choice === 'manual' ? { action: 'manual_published', confirmed: true } : { action: 'confirm', outcome: choice, confirmed: true }, 'Resultado registrado.'); }}>Confirmar</Button></div></Modal>}
  </Modal>;
}
const EDIT: PostStatus[] = ['draft', 'review', 'approved', 'scheduled', 'rejected'];

function HistoryView({ channel, posts, onOpen }: { channel: ListedChannel; posts: ChannelPost[]; onOpen: (post: ChannelPost) => void }) {
  const [events, setEvents] = useState<ChannelEvent[]>([]);
  useEffect(() => { void api.get<ChannelEvent[]>(`/channels/events?channelId=${encodeURIComponent(channel.id)}`).then(setEvents).catch(() => setEvents([])); }, [channel.id, posts.length]);
  const done = posts.filter(post => ['published', 'pending_confirmation', 'failed', 'cancelled', 'expired', 'rejected'].includes(post.status));
  const count = (status: PostStatus) => posts.filter(post => post.status === status).length;
  return <><div className="metric-grid ch-metrics">{(['published', 'pending_confirmation', 'failed', 'expired'] as const).map(status => <div className="panel metric-card" key={status}><div><span className="metric-label">{postStatusNames[status]}</span></div><strong className="metric-value">{String(count(status)).padStart(2, '0')}</strong><span className="metric-note">{status === 'published' ? 'Confirmadas no canal ou por você' : status === 'pending_confirmation' ? 'Aguardando conferência' : status === 'failed' ? 'Não publicadas' : 'Venceram antes de sair'}</span></div>)}</div>
    <div className="settings-grid ch-grid space-top"><PostList title="Resultados" description="O que saiu, o que falhou e o que precisa de conferência." posts={done} onOpen={onOpen} empty="Nenhum resultado ainda." />
      <section className="panel settings-panel"><SectionTitle title="Registro do canal" description="Alterações, envios, pausas e buscas de notícias." /><div className="timeline-list">{events.slice(0, 60).map(event => <div className="timeline-item" key={event.id}><span className={`timeline-icon ch-level-${event.level}`}>{event.level === 'info' ? <Check size={12} /> : <AlertTriangle size={12} />}</span><div className="timeline-content"><p>{event.message}</p><time>{fmt(event.createdAt)}</time></div></div>)}{!events.length && <p className="muted">Nada registrado ainda.</p>}</div><a className="text-link" href="/api/v1/channels/export" download>Exportar dados dos canais (JSON)</a></section></div></>;
}

const listText = (values: string[]) => values.join(', ');
const textList = (value: string) => value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean);

function NewsView({ channel, busy, act, onOpenPost }: { channel: ListedChannel; busy: boolean; act: Act; onOpenPost: (id: string) => void }) {
  const [profile, setProfile] = useState<EditorialProfile>(channel.editorial ?? defaultEditorialProfile());
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [newSource, setNewSource] = useState({ url: '', label: '' });
  const [key, setKey] = useState('');
  const [filter, setFilter] = useState<'new' | 'drafted' | 'all'>('new');
  const [tests, setTests] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const [nextSources, nextItems, nextAi] = await Promise.all([api.get<NewsSource[]>(`/channels/${channel.id}/sources`), api.get<NewsItem[]>(`/channels/${channel.id}/news`), api.get<AiStatus>('/channels/ai')]);
    setSources(nextSources); setItems(nextItems); setAi(nextAi);
  }, [channel.id]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const run = <T,>(operation: () => Promise<T>, success: string) => act(operation, success).then(result => { void load().catch(() => undefined); return result; });
  const set = (patch: Partial<EditorialProfile>) => setProfile(current => ({ ...current, ...patch }));
  const visible = items.filter(item => filter === 'all' ? true : item.status === filter);
  const promotions = channel.purpose === 'promotions';
  return <>
    {promotions && <div className="notice notice-warning"><AlertTriangle size={18} /><p>Este canal é de promoções. Notícias nunca são publicadas nele; use um canal editorial para a curadoria.</p></div>}
    <div className="settings-grid ch-grid">
      <section className="panel settings-panel"><SectionTitle title="Perfil editorial deste canal" description="Nada vem pronto: o tema, as fontes e o estilo são escolhas suas, só deste canal." />
        <Toggle label="Curadoria de notícias ligada" description="Busca as fontes no intervalo escolhido e prepara rascunhos para a fila de aprovação." checked={profile.enabled} onChange={value => set({ enabled: value })} disabled={promotions} />
        <div className="form-row"><Field label="Nome do projeto"><input aria-label="Nome do projeto" maxLength={80} value={profile.projectName} onChange={event => set({ projectName: event.target.value })} /></Field><Field label="Tema principal"><input aria-label="Tema principal" maxLength={120} value={profile.mainTopic} placeholder="Qualquer assunto, do seu jeito" onChange={event => set({ mainTopic: event.target.value })} /></Field></div>
        <Field label="Descrição"><textarea aria-label="Descrição do projeto" rows={2} maxLength={500} value={profile.description} onChange={event => set({ description: event.target.value })} /></Field>
        <Field label="Palavras-chave" hint="Separe por vírgula. No título valem mais."><input aria-label="Palavras-chave" value={listText(profile.keywords)} onChange={event => set({ keywords: textList(event.target.value).slice(0, 100) })} /></Field>
        <div className="form-row"><Field label="Subtemas"><input aria-label="Subtemas" value={listText(profile.subtopics)} onChange={event => set({ subtopics: textList(event.target.value).slice(0, 30) })} /></Field><Field label="Palavras excluídas"><input aria-label="Palavras excluídas" value={listText(profile.excludedWords)} onChange={event => set({ excludedWords: textList(event.target.value).slice(0, 100) })} /></Field></div>
        <div className="form-row"><Field label="Países e regiões"><input aria-label="Países e regiões" value={listText(profile.regions)} onChange={event => set({ regions: textList(event.target.value).slice(0, 30) })} /></Field><Field label="Idiomas" hint="Ex.: pt, en, es. Vazio aceita todos."><input aria-label="Idiomas" value={listText(profile.languages)} onChange={event => set({ languages: textList(event.target.value).map(item => item.toLowerCase()).filter(item => /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(item)).slice(0, 10) })} /></Field></div>
        <div className="form-row"><Field label="Buscar a cada (minutos)"><input aria-label="Frequência de monitoramento" type="number" min={15} max={1440} value={profile.monitorEveryMinutes} onChange={event => set({ monitorEveryMinutes: Number(event.target.value) })} /></Field><Field label="Rascunhos por busca"><input aria-label="Rascunhos por busca" type="number" min={1} max={20} value={profile.maxDraftsPerRun} onChange={event => set({ maxDraftsPerRun: Number(event.target.value) })} /></Field><Field label="Relevância mínima"><input aria-label="Relevância mínima" type="number" min={1} max={20} value={profile.minRelevance} onChange={event => set({ minRelevance: Number(event.target.value) })} /></Field></div>
        <div className="form-row"><Field label="Tom editorial"><input aria-label="Tom editorial" maxLength={120} value={profile.tone} onChange={event => set({ tone: event.target.value })} /></Field><Field label="Tamanho"><select aria-label="Tamanho das matérias" value={profile.length} onChange={event => set({ length: event.target.value as EditorialProfile['length'] })}><option value="short">Curto</option><option value="medium">Médio</option><option value="long">Longo</option></select></Field><Field label="Emojis"><select aria-label="Uso de emojis" value={profile.emojis} onChange={event => set({ emojis: event.target.value as EditorialProfile['emojis'] })}><option value="none">Nenhum</option><option value="few">Poucos</option><option value="many">Mais</option></select></Field></div>
        <Field label="Estilo de escrita"><input aria-label="Estilo de escrita" maxLength={300} value={profile.writingStyle} onChange={event => set({ writingStyle: event.target.value })} /></Field>
        <Toggle label="Marcar fonte única como confirmação pendente" checked={profile.markUnconfirmed} onChange={value => set({ markUnconfirmed: value })} />
        <Toggle label="Análise contextual com IA" description="Fica separada dos fatos, marcada como opinião do canal. Exige IA configurada." checked={profile.analysisEnabled} onChange={value => set({ analysisEnabled: value })} />
        <Field label="Instruções editoriais próprias (para a análise)" hint="Ex.: comparar com fatos históricos, explicar consequências, incluir referências. Nunca são apresentadas como fato."><textarea aria-label="Instruções editoriais" rows={4} maxLength={2000} value={profile.customInstructions} onChange={event => set({ customInstructions: event.target.value })} /></Field>
        <div className="ch-actions"><Button icon={Check} disabled={busy} onClick={() => void run(() => api.put(`/channels/${channel.id}`, { editorial: profile }), 'Perfil editorial salvo.')}>Salvar perfil</Button><Button variant="secondary" icon={RefreshCw} disabled={busy || !sources.length || promotions} onClick={() => void run(() => api.post<{ created: number; drafts: number; errors: string[] }>(`/channels/${channel.id}/news/run`), 'Busca concluída.')}>Buscar agora</Button></div>
      </section>
      <div className="source-groups">
        <section className="panel settings-panel"><SectionTitle title="Fontes de notícias" description="Feeds RSS ou Atom públicos. Só título, resumo da própria fonte, datas e link são guardados." action={<Badge>{sources.length}/30</Badge>} />
          <div className="ch-rows">{sources.map(source => <div className="ch-row" key={source.id}><div><b><Rss size={13} /> {source.label}</b><small className="ch-mono">{source.url}</small><small>{source.lastFetchedAt ? `Lida ${timeAgo(source.lastFetchedAt)}` : 'Ainda não lida'}{source.lastStatus === 'error' ? ` · ${source.lastError}` : ''}</small>{tests[source.id] && <small className={tests[source.id].startsWith('Falha') ? 'ch-error' : ''}>{tests[source.id]}</small>}</div><div className="ch-actions"><Button variant="ghost" disabled={busy} onClick={() => void act(() => api.post<{ ok: boolean; entries: number; sample: string[]; error: string | null }>(`/channels/${channel.id}/sources/${source.id}/test`)).then(result => { if (result) setTests(current => ({ ...current, [source.id]: result.ok ? `Teste ok: ${result.entries} itens. Ex.: ${result.sample[0] ?? '—'}` : `Falha no teste: ${result.error}` })); })}>Testar</Button><Button variant="ghost" disabled={busy} onClick={() => void run(() => api.put(`/channels/${channel.id}/sources/${source.id}`, { active: !source.active }), source.active ? 'Fonte desativada.' : 'Fonte ativada.')}>{source.active ? 'Desativar' : 'Ativar'}</Button><button className="icon-button" aria-label={`Remover a fonte ${source.label}`} disabled={busy} onClick={() => void run(() => api.delete(`/channels/${channel.id}/sources/${source.id}`), 'Fonte removida.')}><Trash2 size={16} /></button></div></div>)}</div>
          <div className="form-row"><Field label="Nome da fonte"><input aria-label="Nome da fonte" maxLength={80} value={newSource.label} onChange={event => setNewSource({ ...newSource, label: event.target.value })} /></Field><Field label="Endereço do feed (HTTPS)"><input aria-label="Endereço do feed" inputMode="url" maxLength={2048} value={newSource.url} placeholder="https://…/rss" onChange={event => setNewSource({ ...newSource, url: event.target.value })} /></Field></div>
          <Button variant="secondary" icon={Plus} disabled={busy || !newSource.url.trim() || !newSource.label.trim()} onClick={() => void run(() => api.post(`/channels/${channel.id}/sources`, { url: newSource.url.trim(), label: newSource.label.trim() }), 'Fonte adicionada.').then(result => { if (result) setNewSource({ url: '', label: '' }); })}>Adicionar fonte</Button>
          <p className="small-note"><ShieldCheck size={13} /> Respeite as condições de uso de cada fonte. O app não copia matérias inteiras nem acessa redes privadas.</p>
        </section>
        <section className="panel settings-panel"><SectionTitle title="Inteligência artificial (opcional)" description="Use a sua própria chave. Sem IA, a curadoria funciona por regras e diz isso claramente." action={<Badge tone={ai?.available ? 'green' : 'neutral'} dot>{ai?.available ? 'Disponível' : 'Desligada'}</Badge>} />
          {ai && <AiForm status={ai} busy={busy} onSave={settings => void run(() => api.put('/channels/ai', settings), 'Configuração de IA salva.')} />}
          <div className="form-row"><Field label="Chave da API do seu provedor" hint="Fica cifrada no seu computador ou servidor; nunca volta para a tela nem entra em backups."><input aria-label="Chave da API" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} /></Field></div>
          <div className="ch-actions"><Button variant="secondary" icon={KeyRound} disabled={busy || key.length < 16} onClick={() => void run(() => api.post('/channels/ai/key', { key }), 'Chave salva.').then(() => setKey(''))}>Salvar chave</Button>{ai?.keyConfigured && <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.delete('/channels/ai/key'), 'Chave removida.')}>Remover chave</Button>}</div>
          {ai && <p className="small-note">{ai.detail} Hoje: {ai.callsToday} de {ai.settings.maxCallsPerDay} chamadas.</p>}
        </section>
      </div>
    </div>
    <section className="panel settings-panel space-top"><SectionTitle title="Notícias capturadas" description="Fatos e datas separados. Fonte única aparece como confirmação pendente." action={<div className="ch-filters">{(['new', 'drafted', 'all'] as const).map(value => <button key={value} className={`example-chip ${filter === value ? 'selected' : ''}`} onClick={() => setFilter(value)}>{value === 'new' ? 'Relevantes' : value === 'drafted' ? 'Viraram rascunho' : 'Todas'}</button>)}</div>} />
      {visible.length ? <div className="ch-rows">{visible.slice(0, 80).map(item => <div className="ch-row ch-news" key={item.id}><div><b>{item.title}</b><small>{item.sourceLabel} · publicado {fmt(item.publishedAt)}{item.updatedAt && item.updatedAt !== item.publishedAt ? ` · atualizado ${fmt(item.updatedAt)}` : ''} · capturado {fmt(item.fetchedAt)} · data do acontecimento não informada</small>{item.excerpt && <small>{item.excerpt.slice(0, 220)}{item.excerpt.length > 220 ? '…' : ''}</small>}<span className="ch-badges"><Badge tone={item.confirmation === 'corroborated' ? 'green' : 'amber'}>{item.confirmation === 'corroborated' ? `Confirmada por ${item.corroboratingSources + 1} fontes` : 'Confirmação pendente'}</Badge><Badge>Relevância {item.relevance}</Badge>{item.status !== 'new' && <Badge>{({ drafted: 'Rascunho criado', ignored: 'Ignorada', duplicate: 'Repetida', excluded: 'Excluída', irrelevant: 'Fora do tema', new: 'Nova' } as const)[item.status]}</Badge>}</span></div><div className="ch-actions">{item.postId ? <Button variant="ghost" onClick={() => onOpenPost(item.postId!)}>Ver rascunho</Button> : <><Button variant="secondary" disabled={busy || promotions} onClick={() => void run(() => api.post(`/channels/${channel.id}/news/${item.id}/draft`), 'Rascunho criado na fila de aprovação.')}>Gerar rascunho</Button>{item.status !== 'ignored' && <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.post(`/channels/${channel.id}/news/${item.id}/ignore`), 'Notícia ignorada.')}>Ignorar</Button>}</>}<a className="button button-ghost" href={item.url} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={15} />Fonte</a></div></div>)}</div> : <p className="muted">{items.length ? 'Nada neste filtro.' : 'Cadastre fontes e palavras-chave, depois use Buscar agora.'}</p>}
    </section>
  </>;
}

function AiForm({ status, busy, onSave }: { status: AiStatus; busy: boolean; onSave: (settings: AiStatus['settings']) => void }) {
  const [settings, setSettings] = useState(status.settings);
  return <>
    <div className="form-row"><Field label="Provedor"><select aria-label="Provedor de IA" value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value as AiStatus['settings']['provider'] })}><option value="none">Sem IA (regras)</option><option value="anthropic">Anthropic</option><option value="openai-compatible">API compatível com OpenAI</option></select></Field><Field label="Modelo" hint="Nome exato indicado pelo seu provedor."><input aria-label="Modelo de IA" maxLength={120} value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value.trim() })} /></Field></div>
    {settings.provider === 'openai-compatible' && <Field label="Endereço da API (HTTPS)"><input aria-label="Endereço da API de IA" value={settings.baseUrl} placeholder="https://…/v1" onChange={event => setSettings({ ...settings, baseUrl: event.target.value.trim() })} /></Field>}
    <div className="form-row"><Field label="Limite de chamadas por dia"><input aria-label="Limite diário de IA" type="number" min={1} max={500} value={settings.maxCallsPerDay} onChange={event => setSettings({ ...settings, maxCallsPerDay: Number(event.target.value) })} /></Field></div>
    <Toggle label="Resumir notícias com IA" checked={settings.summarize} onChange={value => setSettings({ ...settings, summarize: value })} />
    <Toggle label="Sugerir títulos" checked={settings.suggestTitles} onChange={value => setSettings({ ...settings, suggestTitles: value })} />
    <Button variant="secondary" disabled={busy} onClick={() => onSave(settings)}>Salvar IA</Button>
  </>;
}

function ChannelSettingsView({ channel, busy, act }: { channel: ListedChannel; busy: boolean; act: Act }) {
  const [settings, setSettings] = useState(channel.settings);
  const [purpose, setPurpose] = useState(channel.purpose);
  const set = (patch: Partial<Channel['settings']>) => setSettings(current => ({ ...current, ...patch }));
  return <section className="panel settings-panel"><SectionTitle title={`Configurações · ${channel.name}`} description="Cada canal tem as próprias regras. A pausa geral e o botão Pausar do painel também valem aqui." />
    <div className="mode-options">{(['manual', 'assisted', 'automatic'] as const).map(mode => { const locked = mode === 'automatic' && channel.automaticPublishing !== 'available' && settings.mode !== 'automatic'; return <button key={mode} className={`mode-option ${settings.mode === mode ? 'selected' : ''}`} aria-pressed={settings.mode === mode} disabled={locked} onClick={() => set({ mode })}><span className="mode-radio">{settings.mode === mode && <Check size={11} />}</span><span className="eyebrow">{channelModeNames[mode]}</span><h3>{mode === 'manual' ? 'Você aprova e publica' : mode === 'assisted' ? 'Você aprova, o app agenda' : 'O app aprova e publica'}</h3><p>{mode === 'manual' ? 'O sistema prepara; cada publicação espera a sua ação.' : mode === 'assisted' ? 'Ao aprovar, a publicação entra no próximo horário livre.' : locked ? channel.automaticDetail : 'Só depois de uma publicação real comprovada neste canal. Desligado por padrão.'}</p></button>; })}</div>
    <div className="form-row"><Field label="Finalidade"><select aria-label="Finalidade" value={purpose} onChange={event => setPurpose(event.target.value as Channel['purpose'])}><option value="editorial">Editorial</option><option value="promotions">Promoções</option></select></Field><Field label="Fuso horário"><select aria-label="Fuso horário do canal" value={settings.timezone} onChange={event => set({ timezone: event.target.value })}>{['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Cuiaba', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon', 'America/New_York', 'UTC'].map(zone => <option key={zone} value={zone}>{zone.replace('America/', '').replace('Europe/', '').replaceAll('_', ' ')}</option>)}</select></Field></div>
    <div className="form-row"><Field label="Publicar a partir de"><input aria-label="Início da janela" type="time" value={settings.windowStart} onChange={event => set({ windowStart: event.target.value })} /></Field><Field label="Até" hint="Fora disso é horário silencioso."><input aria-label="Fim da janela" type="time" value={settings.windowEnd} onChange={event => set({ windowEnd: event.target.value })} /></Field></div>
    <div className="form-row"><Field label="Intervalo mínimo (min)"><input aria-label="Intervalo mínimo" type="number" min={5} max={1440} value={settings.minIntervalMinutes} onChange={event => set({ minIntervalMinutes: Number(event.target.value) })} /></Field><Field label="Máximo por dia"><input aria-label="Máximo por dia" type="number" min={1} max={48} value={settings.maxPerDay} onChange={event => set({ maxPerDay: Number(event.target.value) })} /></Field><Field label="Urgentes por dia"><input aria-label="Urgentes por dia" type="number" min={0} max={10} value={settings.maxUrgentPerDay} onChange={event => set({ maxUrgentPerDay: Number(event.target.value) })} /></Field></div>
    <div className="form-row"><Field label="Evitar repetição por (dias)"><input aria-label="Dias sem repetição" type="number" min={1} max={90} value={settings.dedupeDays} onChange={event => set({ dedupeDays: Number(event.target.value) })} /></Field><Field label="Validade das notícias (horas)"><input aria-label="Validade das notícias" type="number" min={1} max={336} value={settings.postValidityHours} onChange={event => set({ postValidityHours: Number(event.target.value) })} /></Field></div>
    <Field label="Assinatura" hint={`${settings.signature.length}/240`}><textarea aria-label="Assinatura do canal" rows={2} maxLength={240} value={settings.signature} onChange={event => set({ signature: event.target.value })} /></Field>
    <Toggle label="Pausar este canal" description="Nenhuma publicação deste canal sai enquanto estiver ligado." checked={settings.paused} onChange={value => set({ paused: value })} />
    <div className="ch-actions"><Button icon={Check} disabled={busy} onClick={() => void act(() => api.put(`/channels/${channel.id}`, { settings, purpose }), 'Configurações do canal salvas.')}>Salvar configurações</Button></div>
  </section>;
}
