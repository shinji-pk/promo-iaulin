import { useEffect, useMemo, useRef, useState } from 'react';
import { Iaulin } from './Brand.tsx';
import { ArrowRight, Copy, Search, Sparkles, X } from 'lucide-react';
import { queryMascotBrain, type MascotTopic } from './mascotBrain.ts';

/** Pedidos do ajudante para outras partes da interface (ex.: abrir a recuperação de senha). */
export type HelpAction = 'recover' | 'signup' | 'account';
export const HELP_EVENT = 'promo:help';
export const requestHelp = (action: HelpAction) => window.dispatchEvent(new CustomEvent<HelpAction>(HELP_EVENT, { detail: action }));
export const SUPPORT_URL = (import.meta.env.VITE_SUPPORT_URL as string | undefined)?.trim() || '';

export function Mascot({ size = 40, happy = false }: { size?: number; happy?: boolean }) {
  return <Iaulin size={size} mood={happy ? 'party' : 'happy'} />;
}

const INTRO_KEY = 'promo-iaulin-intro';
export function useIntroBubble(delay = 2400) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let seen: boolean;
    try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch { seen = true; }
    if (seen) return;
    const show = window.setTimeout(() => setVisible(true), delay), hide = window.setTimeout(() => setVisible(false), delay + 9000);
    return () => { window.clearTimeout(show); window.clearTimeout(hide); };
  }, [delay]);
  const dismiss = () => { setVisible(false); try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* só nesta visita */ } };
  return { visible, dismiss };
}

export async function copySupportDetails(): Promise<boolean> {
  const details = ['Promo · Iaulin Bot — informações para suporte', `Data: ${new Date().toLocaleString('pt-BR')}`, `Endereço: ${location.origin}${location.pathname}${location.hash}`, `Navegador: ${navigator.userAgent}`, `Online: ${navigator.onLine ? 'sim' : 'não'}`, '(Nenhuma senha ou dado de conta é incluído.)'].join('\n');
  try { await navigator.clipboard.writeText(details); return true; } catch { return false; }
}

export const loginTopics: (MascotTopic & { action?: [string, HelpAction] })[] = [
  {
    id: 'recover',
    title: 'Esqueci minha senha',
    text: 'Toque em “Esqueci minha senha”. Você recupera com o código de recuperação (o arquivo .txt que baixou ao criar a conta) ou respondendo às suas três perguntas. Maiúsculas e minúsculas não fazem diferença.',
    keywords: ['senha', 'recuperar', 'esqueci', 'perdi', 'redefinir', 'resetar', 'codigo txt', 'perguntas de seguranca', 'login'],
    synonyms: ['perdi meu acesso', 'nao consigo entrar', 'como recuperar a senha', 'esqueci o login', 'trocar senha'],
    action: ['Recuperar minha senha', 'recover'],
  },
  {
    id: 'signup',
    title: 'Ainda não tenho conta',
    text: 'Use “Criar conta”: nome, e-mail, a senha duas vezes e três perguntas de segurança. No fim você baixa o código de recuperação; guarde o arquivo.',
    keywords: ['criar conta', 'cadastro', 'registro', 'novo usuario', 'cadastrar', 'registrar'],
    synonyms: ['quero me cadastrar', 'como criar conta', 'fazer conta nova'],
    action: ['Criar minha conta', 'signup'],
  },
  {
    id: 'profile',
    title: 'Onde mudo meu nome, foto ou telefone?',
    text: 'Depois de entrar, toque no seu avatar (canto superior direito) → Minha conta. Lá você edita nome, nome de usuário, telefone, foto e senha.',
    keywords: ['foto', 'avatar', 'nome', 'telefone', 'perfil', 'editar perfil', 'imagem', 'celular'],
    synonyms: ['como mudar foto', 'alterar telefone', 'mudar meu nome', 'trocar foto de perfil'],
  },
  {
    id: 'security',
    title: 'Meus dados ficam seguros?',
    text: 'Cada conta tem seus dados separados no servidor. Nunca pedimos senha, SMS ou código das lojas e do WhatsApp.',
    keywords: ['seguranca', 'privacidade', 'dados', 'seguro', 'protegido', 'vazamento', 'whatsapp seguro'],
    synonyms: ['e seguro', 'meus dados estao seguros', 'e confiavel', 'privacidade da conta'],
  },
];

const SUGGESTION_PILLS = [
  '🔑 Esqueci a senha',
  '👤 Mudar foto / perfil',
  '🛡️ Meus dados são seguros?',
  '✨ Criar conta',
];

/** Ajudante da tela de entrada (antes do login) com IA integrada e tolerância a erros. */
export function LoginHelp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const intro = useIntroBubble();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const click = (event: MouseEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false); };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, [open]);

  const run = (action: HelpAction) => { setOpen(false); requestHelp(action); };

  // Resposta inteligente calculada com tolerância a erros e sinônimos
  const aiAnswer = useMemo(() => {
    if (!query.trim()) return null;
    return queryMascotBrain(query, loginTopics, 'Iaulin');
  }, [query]);

  return <div className="mascot-help">
    {intro.visible && !open && (
      <div className="mascot-bubble" role="status">
        <button type="button" aria-label="Fechar aviso" onClick={intro.dismiss}><X size={13} /></button>
        <b>Oi! Eu sou o Iaulin ✨</b>
        <span>Travou no login ou esqueceu a senha? Toque em mim.</span>
      </div>
    )}

    {open && (
      <div className="mascot-panel" role="dialog" aria-label="Ajuda para entrar" ref={panel}>
        <header>
          <Mascot size={44} happy />
          <div>
            <b>Precisa de uma mão?</b>
            <span>IA do Iaulin · Tire dúvidas no app</span>
          </div>
          <button type="button" aria-label="Fechar ajuda" onClick={() => setOpen(false)}><X size={17} /></button>
        </header>

        {/* Barra de busca conversacional inteligente */}
        <div className="mascot-search-bar">
          <Search size={15} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Pergunte ao Iaulin (ex: esqeci a senah)..."
            aria-label="Digite sua pergunta ao Iaulin"
            autoFocus
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Limpar busca">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Pílulas de atalho rápido */}
        <div className="mascot-pills" role="toolbar" aria-label="Sugestões de perguntas">
          {SUGGESTION_PILLS.map(pill => {
            const cleanText = pill.replace(/^[^\w\s]+\s*/, '');
            return (
              <button
                key={pill}
                type="button"
                className="mascot-pill"
                onClick={() => setQuery(cleanText)}
              >
                {pill}
              </button>
            );
          })}
        </div>

        {/* Resposta do Mascote */}
        <div className="mascot-topics">
          {aiAnswer ? (
            <div className="mascot-answer-box">
              <div className="mascot-answer-header">
                <span className="mascot-badge">
                  <Sparkles size={11} /> Resposta do Iaulin
                </span>
                {aiAnswer.matchedTopic && (
                  <small style={{ color: '#88687f', fontSize: '11px', fontWeight: 600 }}>
                    {aiAnswer.matchedTopic.title}
                  </small>
                )}
              </div>

              <p className="mascot-answer-text">{aiAnswer.reply}</p>

              {aiAnswer.matchedTopic?.action && (
                <button
                  type="button"
                  className="mascot-action"
                  onClick={() => run(aiAnswer.matchedTopic!.action![1] as HelpAction)}
                >
                  {aiAnswer.matchedTopic.action[0]} <ArrowRight size={14} />
                </button>
              )}

              {aiAnswer.suggestions.length > 0 && (
                <>
                  <span className="mascot-suggestions-title">Outros assuntos que podem ajudar:</span>
                  <div className="mascot-suggestions-list">
                    {aiAnswer.suggestions.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        className="mascot-suggestion-btn"
                        onClick={() => setQuery(s.title)}
                      >
                        {s.title}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            loginTopics.map(topic => (
              <details key={topic.id}>
                <summary>{topic.title}</summary>
                <p>{topic.text}</p>
                {topic.action && (
                  <button type="button" className="mascot-action" onClick={() => run(topic.action![1])}>
                    {topic.action[0]} <ArrowRight size={14} />
                  </button>
                )}
              </details>
            ))
          )}
        </div>

        <footer>
          <button
            type="button"
            onClick={() => void copySupportDetails().then(ok => {
              setCopied(ok);
              window.setTimeout(() => setCopied(false), 2500);
            })}
          >
            <Copy size={14} /> {copied ? 'Copiado!' : 'Copiar dados p/ suporte'}
          </button>
          {SUPPORT_URL && <a href={SUPPORT_URL} target="_blank" rel="noreferrer">Falar com o suporte</a>}
        </footer>
      </div>
    )}

    <button
      ref={trigger}
      type="button"
      className={`mascot-fab ${open ? 'is-open' : ''}`}
      aria-label={open ? 'Fechar ajuda' : 'Ajuda para entrar'}
      aria-expanded={open}
      onClick={() => { intro.dismiss(); setOpen(value => !value); }}
    >
      <Mascot size={40} happy={open} />
    </button>
  </div>;
}
