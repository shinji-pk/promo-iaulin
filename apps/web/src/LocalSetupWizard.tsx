import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Download, Heart, Monitor, QrCode, ShieldCheck, Smartphone } from 'lucide-react';
import { Modal } from './ui.tsx';
import './setup-wizard.css';

const steps = [
  { label: 'Baixar', title: 'Primeiro, vamos baixar seu aplicativo!', description: 'Um toque e o Promo Iaulin chega ao seu computador.', icon: Download },
  { label: 'Instalar', title: 'Agora é só instalar. Bem facinho!', description: 'Abra o arquivo baixado e siga as janelinhas.', icon: Check },
  { label: 'Abrir', title: 'Vamos abrir seu novo ajudante?', description: 'Ele cuida das ofertas enquanto você faz outras coisas.', icon: Monitor },
  { label: 'WhatsApp', title: 'Hora de conectar seu WhatsApp!', description: 'Pegue o celular: vamos ler o quadradinho na tela.', icon: QrCode },
  { label: 'Prontinho', title: 'Oba! A parte difícil já passou.', description: 'Agora você escolhe seus grupos e começa a usar.', icon: Heart },
] as const;

export function LocalSetupWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [phoneType, setPhoneType] = useState<'android' | 'iphone'>('android');
  const [showHelp, setShowHelp] = useState(false);
  const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const info = steps[step];
  const Icon = info.icon;
  const next = () => { setStep(value => Math.min(value + 1, steps.length - 1)); setShowHelp(false); };
  const previous = () => { setStep(value => Math.max(value - 1, 0)); setShowHelp(false); };

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
          <a className="install-wizard-download" href="/api/v1/download/windows" onClick={() => setDownloadStarted(true)}><Download size={21} /> Baixar Promo Iaulin para Windows</a>
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
        <button className="install-wizard-back" type="button" onClick={previous} disabled={step === 0}><ArrowLeft size={18} /> Voltar</button>
        {step < steps.length - 1 ? <button className="install-wizard-next" type="button" onClick={next}>{step === 0 ? 'Já encontrei o arquivo' : step === 1 ? 'Já instalei, vamos lá!' : step === 2 ? 'Abri o WhatsApp, próximo' : 'Já li o código'} <ArrowRight size={18} /></button> : <button className="install-wizard-next" type="button" onClick={onClose}>Concluir e aproveitar <Check size={19} /></button>}
      </div>
      <p className="install-wizard-bottom">🌷 Tudo acontece dentro deste guia. Você pode voltar uma etapa se precisar.</p>
    </div>
  </Modal>;
}
