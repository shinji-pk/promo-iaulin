import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Cloud, Download, Heart, KeyRound, Monitor, QrCode, Server, ShieldCheck, Smartphone } from 'lucide-react';
import { Modal } from './ui.tsx';
import './setup-wizard.css';

const steps = [
  { label: 'Baixar', title: 'Primeiro, vamos baixar seu aplicativo!', description: 'Um toque e o Promo Iaulin chega ao seu computador.', icon: Download },
  { label: 'Instalar', title: 'Agora é só instalar. Bem facinho!', description: 'Abra o arquivo baixado e siga as janelinhas.', icon: Check },
  { label: 'Abrir', title: 'Vamos abrir seu novo ajudante?', description: 'Ele cuida das ofertas enquanto você faz outras coisas.', icon: Monitor },
  { label: 'WhatsApp', title: 'Hora de conectar seu WhatsApp!', description: 'Pegue o celular: vamos ler o quadradinho na tela.', icon: QrCode },
  { label: 'Prontinho', title: 'Oba! A parte difícil já passou.', description: 'Agora você escolhe seus grupos e começa a usar.', icon: Heart },
] as const;

const RENDER_DEPLOY = 'https://render.com/deploy?repo=https://github.com/shinji-pk/promo-iaulin';

async function connectServer(url: string, token: string): Promise<void> {
  const session = await fetch('/api/v1/session', { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
  if (!session.ok) throw new Error('Entre na sua conta para conectar o servidor.');
  const { csrfToken } = await session.json() as { csrfToken: string };
  const response = await fetch('/api/v1/account/server', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(40000),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ url: url.trim(), token: token.trim(), useSavedSettings: true }) });
  let data: { error?: string } = {};
  try { data = await response.json(); } catch { /* resposta sem JSON */ }
  if (!response.ok) throw new Error(data.error || 'Não foi possível conectar agora. Tente novamente em instantes.');
}

/** Primeira escolha: onde o Promo fica ligado o tempo todo (o computador da pessoa ou um servidor dela). */
function PlaceChoice({ onPick }: { onPick: (place: 'computer' | 'server') => void }) {
  return <div className="place-choice" data-testid="place-choice">
    <p className="place-choice-lead">O Promo Iaulin precisa de um lugar <b>sempre ligado</b> para ler os grupos e publicar as ofertas. Você escolhe onde ele mora:</p>
    <div className="place-choice-grid">
      <button type="button" className="place-card" onClick={() => onPick('computer')}>
        <span className="place-card-icon"><Monitor size={30} strokeWidth={1.6} /></span>
        <b>No meu computador</b>
        <p>Instale o programa no Windows. Funciona enquanto o computador estiver ligado.</p>
        <ul><li><Check size={15} /> Sem custo de hospedagem</li><li><Check size={15} /> Guia passo a passo</li></ul>
        <span className="place-card-go">Escolher <ArrowRight size={16} /></span>
      </button>
      <button type="button" className="place-card" onClick={() => onPick('server')}>
        <span className="place-card-icon"><Server size={30} strokeWidth={1.6} /></span>
        <b>Num servidor meu</b>
        <p>Use um servidor seu (Render, VPS ou outro). Fica ligado mesmo com o computador desligado.</p>
        <ul><li><Check size={15} /> Ligado 24 horas</li><li><Check size={15} /> Você só cola o endereço e a chave</li></ul>
        <span className="place-card-go">Escolher <ArrowRight size={16} /></span>
      </button>
    </div>
    <p className="install-wizard-help-text">Dá para trocar depois em <b>Minha conta</b>.</p>
  </div>;
}

function ServerSetup({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    try { await connectServer(url, token); setDone(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível conectar agora.'); }
    finally { setBusy(false); }
  };
  if (done) return <div className="install-wizard-stage server-setup-done">
    <div className="install-wizard-celebration"><div>✨</div><span className="install-wizard-celebration-check"><Check size={34}/></span><div>💜</div></div>
    <p className="install-wizard-explanation"><b>Servidor conectado!</b> Agora o Promo Iaulin trabalha nele o tempo todo. Abra <strong>Fontes & conexões</strong> para conectar o WhatsApp pelo QR Code e escolher os grupos.</p>
    <button className="install-wizard-next" type="button" onClick={onDone}>Ir para o painel</button>
  </div>;
  return <div className="install-wizard-stage server-setup">
    <div className="install-wizard-demo-list">
      <div className="install-wizard-demo-item"><span>1</span><div><b>Tenha o servidor do Promo ligado.</b><p>Ainda não tem? <a href={RENDER_DEPLOY} target="_blank" rel="noreferrer">Criar no Render em um clique ↗</a> (plano sempre ligado). Pode ser também uma VPS ou um servidor em casa com endereço HTTPS.</p></div></div>
      <div className="install-wizard-demo-item"><span>2</span><div><b>Copie o endereço e a chave de acesso.</b><p>O endereço é o link público do servidor (começa com https://). A chave é o valor de <code>PROMOBRIDGE_CLOUD_TOKEN</code> nas configurações dele.</p></div></div>
      <div className="install-wizard-demo-item"><span>3</span><div><b>Cole aqui e conecte.</b><p>A gente testa a conexão antes de salvar. A chave fica guardada cifrada na sua conta.</p></div></div>
    </div>
    <label className="server-field"><span><Cloud size={16} /> Endereço do servidor</span>
      <input type="url" inputMode="url" value={url} onChange={event => setUrl(event.target.value.slice(0, 2048))} placeholder="https://meu-promo.onrender.com" autoComplete="off" spellCheck={false} /></label>
    <label className="server-field"><span><KeyRound size={16} /> Chave de acesso</span>
      <input type="password" value={token} onChange={event => setToken(event.target.value.slice(0, 200))} placeholder="Cole a chave do servidor" autoComplete="off" spellCheck={false} /></label>
    {error && <div className="install-wizard-alert" role="alert">{error}</div>}
    <div className="install-wizard-actions">
      <button className="install-wizard-back" type="button" onClick={onBack} disabled={busy}><ArrowLeft size={18} /> Voltar</button>
      <button className="install-wizard-next" type="button" disabled={busy || !url.trim() || token.trim().length < 20} onClick={() => void submit()}>{busy ? 'Testando a conexão…' : 'Conectar meu servidor'}</button>
    </div>
    <p className="install-wizard-tip"><ShieldCheck size={18} /> O site nunca mostra a chave de novo. Para trocar de servidor, conecte outro em <b>Minha conta</b>.</p>
  </div>;
}

export function LocalSetupWizard({ onClose }: { onClose: () => void }) {
  const [place, setPlace] = useState<'computer' | 'server' | null>(null);
  const [step, setStep] = useState(0);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [phoneType, setPhoneType] = useState<'android' | 'iphone'>('android');
  const [showHelp, setShowHelp] = useState(false);
  const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const info = steps[step];
  const Icon = info.icon;
  const next = () => { setStep(value => Math.min(value + 1, steps.length - 1)); setShowHelp(false); };
  const previous = () => { setStep(value => Math.max(value - 1, 0)); setShowHelp(false); };

  if (place === null) return <Modal title="Onde o Promo Iaulin vai ficar ligado?" subtitle="Escolha uma vez. Depois é só conectar o WhatsApp." wide onClose={onClose}><PlaceChoice onPick={setPlace} /></Modal>;
  if (place === 'server') return <Modal title="Conectar meu servidor" subtitle="Seu Promo Iaulin ligado 24 horas, no lugar que você escolheu." wide onClose={onClose}><ServerSetup onBack={() => setPlace(null)} onDone={() => { onClose(); window.location.reload(); }} /></Modal>;
  return <Modal title="Conecte o WhatsApp sem complicação" subtitle="Eu te acompanho em cada passo. Você só precisa de um computador Windows e do seu celular." wide onClose={onClose}>
    <div className="install-wizard" data-testid="install-wizard">
      <div className="install-wizard-progress" aria-label={'Passo ' + (step + 1) + ' de ' + steps.length}>
        {steps.map((part, index) => <button type="button" key={part.label}
          className={'install-wizard-progress-item' + (index === step ? ' is-current' : '') + (index < step ? ' is-done' : '')}
          disabled={index > step} aria-current={index === step ? 'step' : undefined}
          onClick={() => { setStep(index); setShowHelp(false); }}>
          <span className="install-wizard-progress-circle">{index < step ? <Check size={16} /> : index + 1}</span>
          <span>{part.label}</span>
        </button>)}
      </div>
      <div className="install-wizard-meter" role="progressbar" aria-label="Progresso da instalação" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={steps.length}>
        <span style={{ width: ((step + 1) / steps.length * 100) + '%' }} />
      </div>
      <div className="install-wizard-content" aria-live="polite">
        <div className="install-wizard-heading">
          <div className="install-wizard-hero-icon"><Icon size={33} strokeWidth={1.7} /></div>
          <div><span className="install-wizard-kicker">PASSO {step + 1} DE {steps.length} · FEITO COM CARINHO 💜</span><h3>{info.title}</h3><p>{info.description}</p></div>
        </div>

        {step === 0 && <div className="install-wizard-stage">
          <div className="install-wizard-illustration">
            <div className="install-wizard-computer"><div className="install-wizard-computer-screen"><div className="install-wizard-logo">P<span>↗</span></div><b>Promo Iaulin</b><small>Seu cantinho de ofertas</small></div><div className="install-wizard-computer-neck" /></div>
            <div className="install-wizard-file"><Download size={30} /><b>Promo Iaulin</b><span>.exe</span></div>
          </div>
          {mobileDevice ? <p className="install-wizard-alert">Você está pelo celular? Tudo bem! 💜 Abra o site também em um computador com Windows para baixar e instalar o programa. Depois, use este celular para ler o código.</p> : <p className="install-wizard-explanation">Clique no botão abaixo. O navegador vai baixar o programa automaticamente. <b>Você continua aqui no guia.</b></p>}
          <a className="install-wizard-download" href="https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-latest/Promo-Iaulin-Setup.exe" onClick={() => setDownloadStarted(true)}><Download size={21} /> Baixar Promo Iaulin para Windows</a>
          <p className="install-wizard-help-text">{downloadStarted ? 'Ótimo! Veja o download no navegador ou na pasta Downloads. Quando encontrar o arquivo, continue. ✓' : 'É o arquivo Promo-Iaulin-Setup.exe. Não precisa procurar em outro site.'}</p>
        </div>}

        {step === 1 && <div className="install-wizard-stage">
          <div className="install-wizard-demo-list">
            <div className="install-wizard-demo-item"><span>1</span><div><b>Encontre o que acabou de baixar.</b><p>Abra a pasta <strong>Downloads</strong> do Windows e procure <strong>Promo-Iaulin-Setup.exe</strong>.</p></div></div>
            <div className="install-wizard-demo-item"><span>2</span><div><b>Dê dois cliques no arquivo.</b><p>Vai aparecer uma janelinha de instalação. Siga as instruções na tela.</p></div></div>
            <div className="install-wizard-demo-item"><span>3</span><div><b>Terminou? Abra o Promo Iaulin!</b><p>Ele vai aparecer nos aplicativos do Windows e pode criar um atalho na área de trabalho.</p></div></div>
          </div>
          <button className="install-wizard-help-toggle" type="button" aria-expanded={showHelp} onClick={() => setShowHelp(value => !value)}>O Windows mostrou um aviso de segurança? <ChevronRight size={17} /></button>
          {showHelp && <div className="install-wizard-alert">Esta versão de teste ainda não tem assinatura digital, então o Windows pode avisar que não reconhece o editor. Confira se você baixou pelo botão oficial deste guia e peça ajuda caso tenha dúvidas. <b>Não desative o antivírus nem as proteções do Windows.</b></div>}
        </div>}

        {step === 2 && <div className="install-wizard-stage">
          <div className="install-wizard-app-demo" aria-label="Exemplo da janela do Promo Iaulin">
            <div className="install-wizard-app-bar"><span className="install-wizard-app-brand">P↗</span><b>Promo Iaulin</b><span className="install-wizard-app-dots">● ● ●</span></div>
            <p>Seu espaço de ofertas e WhatsApp</p>
            <div className="install-wizard-app-status"><span className="install-wizard-pulse" /> Pronto para começar</div>
            <span className="install-wizard-app-button"><QrCode size={18} /> Conectar WhatsApp</span>
          </div>
          <p className="install-wizard-explanation">Apareceu uma janelinha parecida? Clique em <strong>Conectar WhatsApp</strong>. Se abrir o painel do aplicativo, clique em <strong>Conectar WhatsApp</strong> ali também para mostrar o código.</p>
          <p className="install-wizard-tip"><ShieldCheck size={18} /> Pode minimizar o programa. Deixe o computador ligado para as ofertas continuarem funcionando.</p>
        </div>}

        {step === 3 && <div className="install-wizard-stage">
          <div className="install-wizard-phone-tabs" role="group" aria-label="Escolha seu celular">
            <button type="button" className={phoneType === 'android' ? 'is-selected' : ''} aria-pressed={phoneType === 'android'} onClick={() => setPhoneType('android')}>🤖 Android</button>
            <button type="button" className={phoneType === 'iphone' ? 'is-selected' : ''} aria-pressed={phoneType === 'iphone'} onClick={() => setPhoneType('iphone')}>🍎 iPhone</button>
          </div>
          <div className="install-wizard-phone-steps">
            <div className="install-wizard-phone-illustration"><Smartphone size={75} strokeWidth={1.1}/><span><QrCode size={27}/></span></div>
            <div className="install-wizard-demo-list">
              <div className="install-wizard-demo-item"><span>1</span><div><b>Abra o WhatsApp no celular.</b><p>{phoneType === 'android' ? 'Toque nos três pontinhos (⋮) e escolha Dispositivos conectados.' : 'Toque em Ajustes e depois em Dispositivos conectados.'}</p></div></div>
              <div className="install-wizard-demo-item"><span>2</span><div><b>Toque em Conectar dispositivo.</b><p>O celular vai abrir a câmera para ler o código.</p></div></div>
              <div className="install-wizard-demo-item"><span>3</span><div><b>Aponte para o quadradinho no computador.</b><p>Leia o QR Code que apareceu no painel do Promo Iaulin. Quando aparecer conectado, deu certo! 🎉</p></div></div>
            </div>
          </div>
        </div>}

        {step === 4 && <div className="install-wizard-stage">
          <div className="install-wizard-celebration"><div>✨</div><span className="install-wizard-celebration-check"><Check size={34}/></span><div>💜</div></div>
          <div className="install-wizard-next-steps">
            <b>Agora, no painel do Promo Iaulin:</b>
            <p><span>1</span> Abra <strong>Fontes & conexões</strong> e escolha os grupos de onde as ofertas vão chegar.</p>
            <p><span>2</span> Escolha o grupo onde você quer publicar.</p>
            <p><span>3</span> Salve suas escolhas e pronto!</p>
          </div>
          <p className="install-wizard-tip"><Heart size={18} /> Quer acompanhar pelo site também? No programa, clique em <b>Vincular minha conta online</b> e confirme a conexão no site. É opcional.</p>
          <a className="install-wizard-local" href="http://127.0.0.1:3030/#sources" target="_blank" rel="noreferrer"><Monitor size={18}/> Abrir meu painel no computador</a>
          <p className="install-wizard-help-text">O painel abre apenas no computador em que o aplicativo foi instalado e está funcionando.</p>
        </div>}
      </div>
      <div className="install-wizard-actions">
        <button className="install-wizard-back" type="button" onClick={() => step === 0 ? setPlace(null) : previous()}><ArrowLeft size={18} /> Voltar</button>
        {step < steps.length - 1 ? <button className="install-wizard-next" type="button" onClick={next}>{step === 0 ? 'Já encontrei o arquivo' : step === 1 ? 'Já instalei, vamos lá!' : step === 2 ? 'Já abri o programa' : 'Já li o código'} <ArrowRight size={18} /></button> : <button className="install-wizard-next" type="button" onClick={onClose}>Concluir e aproveitar <Check size={19} /></button>}
      </div>
      <p className="install-wizard-bottom">🌷 Tudo acontece dentro deste guia. Você pode voltar uma etapa se precisar.</p>
    </div>
  </Modal>;
}
