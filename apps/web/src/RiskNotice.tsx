import { useState } from 'react';
import { AlertTriangle, Check, Gauge, LoaderCircle, ShieldCheck, Smartphone } from 'lucide-react';
import { RISK_NOTICE_VERSION, paceRiskCovered, sendingPaceRisk, type PaceRisk, type Settings } from '../../../packages/shared/src/index.ts';
import { Field } from './ui.tsx';
import './risk-notice.css';

const commitments = [
  { id: 'number', text: 'Vou usar um número de WhatsApp alternativo (um chip só para o grupo), e não o meu número pessoal ou o principal da minha empresa.' },
  { id: 'ban', text: 'Entendo que o WhatsApp pode restringir ou banir o número que envia muitas mensagens, e que isso pode acontecer mesmo com cuidado.' },
  { id: 'pace', text: 'O ritmo de envio é escolha minha. Ritmos mais rápidos aumentam o risco e ficam por minha conta.' },
  { id: 'consent', text: 'Só vou enviar para grupos que eu administro ou em que as pessoas aceitaram receber ofertas.' },
] as const;

/** Tela que aparece antes de tudo. Nada é liberado (nem publicação) até a pessoa aceitar. */
export function RiskNoticeGate({ onAccept }: { onAccept: () => Promise<void> }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const all = commitments.every(item => checked[item.id]);
  async function accept() {
    if (!all || busy) return;
    setBusy(true); setError('');
    try { await onAccept(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar seu aceite. Tente de novo.'); } finally { setBusy(false); }
  }
  return <div className="risk-gate" role="dialog" aria-modal="true" aria-labelledby="risk-title">
    <div className="risk-card">
      <span className="risk-badge"><AlertTriangle size={15} /> Leia antes de começar</span>
      <h1 id="risk-title">Proteja o seu número<span className="heading-dot">.</span></h1>
      <p className="risk-lead">O bot envia mensagens pelo WhatsApp de um número conectado por QR Code. O WhatsApp não tem um limite oficial para isso e pode bloquear números que enviam muitas mensagens, recebem denúncias ou parecem automáticos.</p>
      <div className="risk-why">
        <div><Smartphone size={18} /><p><b>Por que um número alternativo?</b> Se esse número for restringido, você perde o acesso a ele (conversas, grupos e contatos). Com um chip separado, seu número pessoal e o da sua empresa ficam seguros.</p></div>
        <div><Gauge size={18} /><p><b>O ritmo faz diferença.</b> Intervalos maiores entre os envios e menos mensagens por hora reduzem o risco. Você escolhe o ritmo em Automação, com um medidor de risco.</p></div>
        <div><ShieldCheck size={18} /><p><b>Futuro:</b> estamos preparando a opção pela API oficial do WhatsApp, que é paga, mas não depende de QR Code.</p></div>
      </div>
      <fieldset className="risk-checks"><legend>Para continuar, confirme:</legend>
        {commitments.map(item => <label key={item.id} className={checked[item.id] ? 'on' : ''}><input type="checkbox" checked={Boolean(checked[item.id])} onChange={event => setChecked(previous => ({ ...previous, [item.id]: event.target.checked }))} /><span className="risk-box">{checked[item.id] && <Check size={12} />}</span><span>{item.text}</span></label>)}
      </fieldset>
      {error && <p className="risk-error" role="alert">{error}</p>}
      <button className="button button-primary risk-accept" type="button" disabled={!all || busy} onClick={() => void accept()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{all ? 'Entendi e aceito, continuar' : `Marque os ${commitments.length} itens para continuar`}</button>
      <p className="risk-foot">Seu aceite fica salvo na sua conta (versão {RISK_NOTICE_VERSION} do aviso). Se o texto mudar, vamos pedir de novo.</p>
    </div>
  </div>;
}

export function acceptedRiskNotice(settings: Settings): Settings {
  return { ...settings, riskNotice: { version: RISK_NOTICE_VERSION, acceptedAt: new Date().toISOString() } };
}

const presets = [
  { id: 'calm', label: 'Cuidadoso', detail: '1 a cada 15 min · até 4/h', maxPostsPerHour: 4, minIntervalMinutes: 15 },
  { id: 'balanced', label: 'Equilibrado', detail: '1 a cada 8 min · até 6/h', maxPostsPerHour: 6, minIntervalMinutes: 8 },
  { id: 'fast', label: 'Rápido', detail: '1 a cada 3 min · até 12/h', maxPostsPerHour: 12, minIntervalMinutes: 3 },
] as const;
const riskText: Record<PaceRisk, { label: string; detail: string }> = {
  low: { label: 'Risco menor', detail: 'Ritmo calmo, parecido com uma pessoa postando.' },
  moderate: { label: 'Risco moderado', detail: 'Funciona, mas fique de olho em avisos do WhatsApp.' },
  high: { label: 'Risco alto', detail: 'Ritmo agressivo. A chance de restrição do número aumenta bastante.' },
};
function minutes(ms: number) { const value = ms / 60_000; return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10; }

/** Controle do ritmo de envio: presets, valores livres, variação e aceite do risco quando o ritmo é alto. */
export function SendingPace({ draft, onChange }: { draft: Settings; onChange: (settings: Settings) => void }) {
  const risk = sendingPaceRisk(draft);
  const covered = paceRiskCovered(draft);
  const longest = draft.minIntervalMinutes * 60_000 * (1 + draft.intervalJitterPercent / 100);
  const set = (patch: Partial<Settings>) => onChange({ ...draft, ...patch });
  return <div className="pace">
    <div className="pace-presets" role="group" aria-label="Ritmos sugeridos">{presets.map(preset => { const active = draft.maxPostsPerHour === preset.maxPostsPerHour && draft.minIntervalMinutes === preset.minIntervalMinutes; return <button type="button" key={preset.id} className={active ? 'active' : ''} aria-pressed={active} onClick={() => set({ maxPostsPerHour: preset.maxPostsPerHour, minIntervalMinutes: preset.minIntervalMinutes })}><b>{preset.label}</b><span>{preset.detail}</span></button>; })}</div>
    <div className="form-row"><Field label="No máximo, por hora"><input aria-label="Máximo de publicações por hora" type="number" min="1" max="30" value={draft.maxPostsPerHour} onChange={event => set({ maxPostsPerHour: Math.max(1, Math.min(30, Number(event.target.value) || 1)) })} /></Field><Field label="Tempo entre envios (min)"><input aria-label="Intervalo mínimo em minutos" type="number" min="1" max="1440" value={draft.minIntervalMinutes} onChange={event => set({ minIntervalMinutes: Math.max(1, Math.min(1440, Number(event.target.value) || 1)) })} /></Field></div>
    <Field label={`Variação aleatória · até +${draft.intervalJitterPercent}%`} hint={draft.intervalJitterPercent ? `Cada envio espera entre ${draft.minIntervalMinutes} e ${minutes(longest)} min, para não parecer robô.` : 'Sem variação: os envios saem sempre no mesmo intervalo.'}><input aria-label="Variação aleatória do intervalo" type="range" min="0" max="100" step="5" value={draft.intervalJitterPercent} onChange={event => set({ intervalJitterPercent: Number(event.target.value) })} style={{ '--range-progress': `${draft.intervalJitterPercent}%` } as React.CSSProperties} /></Field>
    <div className={`pace-meter pace-${risk}`} role="status"><div className="pace-bars" aria-hidden="true"><span /><span /><span /></div><div><b>{riskText[risk].label}</b><p>{riskText[risk].detail} É uma referência de cautela, não uma garantia.</p></div></div>
    {risk === 'high' && <label className={`pace-accept ${covered ? 'on' : ''}`}><input type="checkbox" checked={covered} onChange={event => set({ paceRiskAccepted: event.target.checked ? { maxPostsPerHour: draft.maxPostsPerHour, minIntervalMinutes: draft.minIntervalMinutes, acceptedAt: new Date().toISOString() } : null })} /><span className="risk-box">{covered && <Check size={12} />}</span><span><b>Assumo o risco deste ritmo.</b> Sei que o número pode ser restringido e que a escolha é minha. Sem essa confirmação, as publicações ficam pausadas.</span></label>}
  </div>;
}
