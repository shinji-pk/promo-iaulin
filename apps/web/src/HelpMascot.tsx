import { useEffect, useRef, useState } from 'react';
import { Iaulin } from './Brand.tsx';
import { ArrowRight, Copy, X } from 'lucide-react';

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

const loginTopics: { title: string; text: string; action?: [string, HelpAction] }[] = [
  { title: 'Esqueci minha senha', text: 'Toque em “Esqueci minha senha”. Você recupera com o código de recuperação (o arquivo .txt que baixou ao criar a conta) ou respondendo às suas três perguntas. Maiúsculas e minúsculas não fazem diferença.', action: ['Recuperar minha senha', 'recover'] },
  { title: 'Ainda não tenho conta', text: 'Use “Criar conta”: nome, e-mail, a senha duas vezes e três perguntas de segurança. No fim você baixa o código de recuperação; guarde o arquivo.', action: ['Criar minha conta', 'signup'] },
  { title: 'Onde mudo meu nome, foto ou telefone?', text: 'Depois de entrar, toque no seu avatar (canto superior direito) → Minha conta. Lá você edita nome, nome de usuário, telefone, foto e senha.' },
  { title: 'Meus dados ficam seguros?', text: 'Cada conta tem seus dados separados no servidor. Nunca pedimos senha, SMS ou código das lojas e do WhatsApp.' },
];

/** Ajudante da tela de entrada (antes do login). */
export function LoginHelp() {
  const [open, setOpen] = useState(false), [copied, setCopied] = useState(false);
  const intro = useIntroBubble();
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const click = (event: MouseEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, [open]);
  const run = (action: HelpAction) => { setOpen(false); requestHelp(action); };
  return <div className="mascot-help">
    {intro.visible && !open && <div className="mascot-bubble" role="status"><button type="button" aria-label="Fechar aviso" onClick={intro.dismiss}><X size={13} /></button><b>Oi! Eu sou o Iaulin ✨</b><span>Travou no login ou esqueceu a senha? Toque em mim.</span></div>}
    {open && <div className="mascot-panel" role="dialog" aria-label="Ajuda para entrar" ref={panel}>
      <header><Mascot size={44} happy /><div><b>Precisa de uma mão?</b><span>Respostas rápidas do Iaulin</span></div><button type="button" aria-label="Fechar ajuda" onClick={() => setOpen(false)}><X size={17} /></button></header>
      <div className="mascot-topics">{loginTopics.map(topic => <details key={topic.title}><summary>{topic.title}</summary><p>{topic.text}</p>{topic.action && <button type="button" className="mascot-action" onClick={() => run(topic.action![1])}>{topic.action[0]} <ArrowRight size={14} /></button>}</details>)}</div>
      <footer><button type="button" onClick={() => void copySupportDetails().then(ok => { setCopied(ok); window.setTimeout(() => setCopied(false), 2500); })}><Copy size={14} /> {copied ? 'Copiado!' : 'Copiar dados p/ suporte'}</button>{SUPPORT_URL && <a href={SUPPORT_URL} target="_blank" rel="noreferrer">Falar com o suporte</a>}</footer>
    </div>}
    <button ref={trigger} type="button" className={`mascot-fab ${open ? 'is-open' : ''}`} aria-label={open ? 'Fechar ajuda' : 'Ajuda para entrar'} aria-expanded={open} onClick={() => { intro.dismiss(); setOpen(value => !value); }}><Mascot size={40} happy={open} /></button>
  </div>;
}
