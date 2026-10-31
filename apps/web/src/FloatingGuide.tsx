import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, CircleHelp, Download, Search, Sparkles, X } from 'lucide-react';
import { api } from './api.ts';
import { LocalSetupModal } from './FeaturePanels.tsx';
import type { SetupStatus } from '../../../packages/shared/src/features.ts';
import { useAccount } from './AccountGate.tsx';
import { Mascot, SUPPORT_URL, copySupportDetails, useIntroBubble } from './HelpMascot.tsx';
import { queryMascotBrain, type MascotTopic } from './mascotBrain.ts';

const steps = [
  { title: '1. Prepare o aplicativo', page: 'sources', text: 'Abra o guia visual dentro deste aplicativo. Ele vai te ajudar a baixar, instalar e conectar o WhatsApp, uma tela de cada vez. Mantenha o PromoBridge em execução para receber e publicar ofertas no WhatsApp. A aba do site pode ser fechada. Encerrar o programa interrompe a automação, mas não apaga os dados salvos. No programa, use Vincular minha conta online e confirme o vínculo no site, sem precisar copiar códigos.' },
  { title: '2. Conecte seu WhatsApp', page: 'sources', text: 'Em Fontes & conexões, clique em Conectar WhatsApp. No WhatsApp do celular, abra Dispositivos conectados (menu ⋮ no Android ou Ajustes no iPhone) → Conectar dispositivo e leia o QR Code do painel.' },
  { title: '3. Escolha os grupos', page: 'sources', text: 'Selecione os grupos-fonte de onde chegam promoções e o grupo de vendas que receberá suas ofertas. O destino precisa ser diferente das fontes. Se o grupo permitir só administradores, seu número precisa ter essa permissão.' },
  { title: '4. Configure seus afiliados', page: 'affiliates', text: 'Em Lojas & afiliados, habilite cada loja e informe sua identificação. Onde houver API disponível para sua conta, conecte e teste. Para as outras lojas, gere o link no portal oficial e adicione o par exato de produto e link na biblioteca. A biblioteca pede sua revisão antes de cada publicação.' },
  { title: '5. Faça sua primeira revisão', page: 'queue', text: 'Use Adicionar oferta para colar uma promoção real ou aguarde uma mensagem das fontes. Abra a oferta, confira produto, preço, cupom, link e mensagem final. Corrija os dados se precisar. Aprovar prepara a oferta; Publicar envia. Simular oferta apenas testa, sem enviar.' },
  { title: '6. Ajuste a rotina do grupo', page: 'automation', text: 'Comece em modo manual. Defina score mínimo, intervalo entre ofertas, limite por hora, horário de silêncio e validade. Você pode agendar uma oferta aprovada. Pausar interrompe os envios e mantém a fila. As regras são conferidas novamente na hora de publicar.' },
  { title: '7. Acompanhe os resultados', page: 'health', text: 'Veja Publicados para conferir os envios e Saúde & atividade para entender bloqueios e quedas de conexão. Um envio incerto precisa de conferência no grupo: marque o resultado na oferta para evitar uma mensagem repetida.' },
];

const features = [
  ['Hoje', 'Visão do seu grupo: ofertas recebidas, fila, publicações e configuração pendente.', 'today'],
  ['Fila de curadoria', 'Revise, corrija, aprove, rejeite, publique ou agende cada oferta.', 'queue'],
  ['Descobertas', 'Explore e filtre o que chegou antes de escolher o que combina com seu público.', 'discover'],
  ['Publicados', 'Confira o histórico de ofertas e o resultado de cada tentativa de envio.', 'published'],
  ['Fontes & conexões', 'Conecte WhatsApp, escolha grupos e prepare o acesso ao computador.', 'sources'],
  ['Lojas & afiliados', 'Configure contas, teste APIs e mantenha uma biblioteca de links oficiais por produto.', 'affiliates'],
  ['Audiência', 'Dê prioridade às categorias do grupo e bloqueie palavras ou lojas.', 'audience'],
  ['Automação', 'Escolha o nível de controle, frequência, silêncio e regras contra repetição.', 'automation'],
  ['Mensagens', 'Ajuste a linguagem, o convite e a assinatura que aparecem nas ofertas.', 'messages'],
  ['Saúde & atividade', 'Descubra por que uma oferta não saiu e acompanhe a conexão.', 'health'],
  ['Configurações', 'Prepare backups, restaure dados, limpe registros antigos e reabra a preparação inicial.', 'settings'],
] as const;

const helpFaqs = [
  { title: 'Meus dados ficam salvos?', text: 'No site, suas preferências e os dados sincronizados ficam no servidor, dentro da sua conta. Você pode sair e entrar novamente. No aplicativo do computador, a fila e a sessão do WhatsApp ficam salvas localmente. Faça backups pela tela Configurações.' },
  { title: 'Por que não publicou?', text: 'Abra a oferta e leia os motivos. Confira conexão, aprovação, loja, link afiliado, destino, validade, score e horário. Se for um envio incerto, confira primeiro no WhatsApp antes de confirmar o resultado.' },
  { title: 'Preciso deixar o site ou o aplicativo aberto?', text: 'Você pode fechar a aba do site: isso não desliga o bot nem apaga seus dados. Para captar mensagens e publicar ofertas automaticamente, o computador precisa estar ligado com o PromoBridge em execução. Se desligar o PC ou fechar o programa, a automação para, mas a conta online mantém as preferências salvas e o computador mantém os dados locais. Ao iniciar o PromoBridge novamente, ele tenta retomar a sessão do WhatsApp salva. Mensagens que chegarem durante a interrupção podem não ser capturadas.' },
  { title: 'Todas as lojas geram links automaticamente?', text: 'Depende do acesso disponível na sua conta do programa. Amazon, Shopee e AliExpress têm conectores configuráveis. As outras lojas usam links gerados no portal oficial e importados por produto. Cada tela mostra o que está conectado e o que ainda precisa de configuração.' },
  { title: 'O app confirma o pagamento da comissão?', text: 'Ele protege a identidade do produto e o link configurado. A elegibilidade e a comissão são confirmadas pelo programa de afiliados de cada loja. Você acompanha os ganhos no portal oficial da loja.' },
  { title: 'Como o app escolhe as melhores ofertas?', text: 'Ele usa preço e condições informados na mensagem, categorias, suas preferências e feedback. O score explica os fatores. Confira preços e cupons antes de publicar: eles podem mudar.' },
];

const allGuideTopics: (MascotTopic & { page?: string })[] = [
  ...steps.map(s => ({
    id: `step-${s.page}`,
    title: s.title,
    text: s.text,
    keywords: ['passo', 'etapa', 'como fazer', 'tutorial', ...s.title.toLowerCase().split(' ')],
    action: ['Abrir esta etapa', s.page] as [string, string],
    page: s.page,
  })),
  ...features.map(([name, text, page]) => ({
    id: `feature-${page}`,
    title: name,
    text,
    keywords: ['tela', 'modulo', 'painel', 'secao', name.toLowerCase()],
    action: ['Abrir tela de ' + name, page] as [string, string],
    page,
  })),
  ...helpFaqs.map(h => ({
    id: `faq-${h.title.slice(0, 15)}`,
    title: h.title,
    text: h.text,
    keywords: ['duvida', 'faq', 'pergunta', ...h.title.toLowerCase().split(' ')],
  })),
  {
    id: 'account-profile',
    title: 'Editar nome, usuário, foto e telefone',
    text: 'Tudo fica em Minha conta: toque no seu avatar no canto superior direito. As mudanças acompanham seu login em qualquer aparelho.',
    keywords: ['perfil', 'foto', 'avatar', 'nome', 'telefone', 'celular'],
    page: 'account',
  },
  {
    id: 'account-recover',
    title: 'Esqueci minha senha',
    text: 'Saia da conta e, na tela de entrada, toque em Esqueci minha senha. Use o código de recuperação (arquivo .txt baixado no cadastro) ou responda às suas três perguntas.',
    keywords: ['senha', 'esqueci', 'recuperar', 'perdi'],
  },
];

export function FloatingGuide() {
  const [setupOpen, setSetupOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'steps' | 'features' | 'help' | 'account'>('steps');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const account = useAccount();
  const intro = useIntroBubble(3200);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void api.get<SetupStatus>('/setup').then(value => { if (active) setSetup(value); }).catch(() => undefined);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', escape);
    return () => { active = false; window.removeEventListener('keydown', escape); };
  }, [open]);

  const go = (page: string) => {
    if (page === 'account') {
      setOpen(false);
      account.open();
      return;
    }
    window.location.hash = page;
    setOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const aiAnswer = useMemo(() => {
    if (!query.trim()) return null;
    return queryMascotBrain(query, allGuideTopics, 'Iaulin');
  }, [query]);

  return (
    <div className="floating-guide">
      {intro.visible && !open && (
        <div className="mascot-bubble guide-bubble" role="status">
          <button type="button" aria-label="Fechar aviso" onClick={intro.dismiss}>
            <X size={13} />
          </button>
          <b>Oi! Eu sou o Iaulin ✨</b>
          <span>Passo a passo, dúvidas e sua conta: é só me chamar.</span>
        </div>
      )}

      <button
        className="guide-launcher"
        onClick={() => { intro.dismiss(); setOpen(value => !value); }}
        aria-expanded={open}
        aria-controls="sales-guide"
      >
        <span className="guide-mascot">
          <Mascot size={34} happy={open} />
        </span>
        <span>Guia do meu grupo</span>
        {open ? <X size={16} /> : <CircleHelp size={16} />}
      </button>

      {open && (
        <section className="guide-panel" id="sales-guide" role="dialog" aria-label="Guia do seu grupo de vendas">
          <header>
            <div>
              <span className="eyebrow">SEU ASSISTENTE POR AQUI</span>
              <h2>Vamos fazer funcionar.</h2>
              <p>IA do Iaulin · Pergunte sobre qualquer etapa ou configuração.</p>
            </div>
            <button className="icon-button" aria-label="Fechar guia" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
          </header>

          {/* Barra de busca inteligente com IA no guia */}
          <div className="mascot-search-bar" style={{ margin: '10px 16px 4px' }}>
            <Search size={15} />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Pergunte ao Iaulin (ex: como conectar o zap, afliados)..."
              aria-label="Pergunte qualquer dúvida"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Limpar">
                <X size={14} />
              </button>
            )}
          </div>

          {aiAnswer ? (
            <div className="guide-content" style={{ padding: '12px 16px' }}>
              <div className="mascot-answer-box" style={{ margin: 0 }}>
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
                    onClick={() => go((aiAnswer.matchedTopic as any).page || aiAnswer.matchedTopic!.action![1])}
                  >
                    {aiAnswer.matchedTopic.action[0]} <ArrowRight size={14} />
                  </button>
                )}

                {aiAnswer.suggestions.length > 0 && (
                  <>
                    <span className="mascot-suggestions-title">Veja também:</span>
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
            </div>
          ) : (
            <>
              <div className="guide-tabs" role="tablist" aria-label="Conteúdo do guia">
                {([['steps', 'Passo a passo'], ['features', 'Funcionalidades'], ['help', 'Dúvidas'], ['account', 'Conta & suporte']] as const).map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="guide-content">
                {tab === 'steps' && (
                  <>
                    {setup && (
                      <div className="guide-progress">
                        <b>
                          {setup.ready
                            ? 'Tudo preparado para começar'
                            : `${setup.checks.filter(v => v.ready).length} de ${setup.checks.length} preparações concluídas`}
                        </b>
                        <p>{setup.next}</p>
                        {setup.checks.filter(v => v.ready).map(v => (
                          <span key={v.key}><Check size={15} />{v.label}</span>
                        ))}
                      </div>
                    )}
                    {steps.map(step => (
                      <details key={step.title}>
                        <summary>{step.title}</summary>
                        <p>{step.text}</p>
                        <button className="guide-link" onClick={() => go(step.page)}>
                          Abrir esta etapa <ArrowRight size={15} />
                        </button>
                      </details>
                    ))}
                    <button type="button" className="guide-download" onClick={() => { setOpen(false); setSetupOpen(true); }}>
                      <Download size={17} /> Abrir instalação guiada do WhatsApp
                    </button>
                  </>
                )}

                {tab === 'features' && features.map(([name, text, page]) => (
                  <button className="guide-feature" key={page} onClick={() => go(page)}>
                    <div>
                      <b>{name}</b>
                      <p>{text}</p>
                    </div>
                    <ArrowRight size={17} />
                  </button>
                ))}

                {tab === 'help' && helpFaqs.map(faq => (
                  <details key={faq.title}>
                    <summary>{faq.title}</summary>
                    <p>{faq.text}</p>
                  </details>
                ))}

                {tab === 'account' && (
                  <div className="guide-account">
                    <details open>
                      <summary>Editar nome, usuário, foto e telefone</summary>
                      <p>Tudo fica em Minha conta: toque no seu avatar no canto superior direito. As mudanças acompanham seu login em qualquer aparelho.</p>
                      {account.cloud && (
                        <button className="guide-link" onClick={() => { setOpen(false); account.open(); }}>
                          Abrir Minha conta <ArrowRight size={15} />
                        </button>
                      )}
                    </details>
                    <details>
                      <summary>Esqueci minha senha</summary>
                      <p>Saia da conta e, na tela de entrada, toque em Esqueci minha senha. Use o código de recuperação (arquivo .txt baixado no cadastro) ou responda às suas três perguntas.</p>
                    </details>
                    <details>
                      <summary>Trocar a senha</summary>
                      <p>Em Minha conta você troca a senha informando a atual. Depois, baixe um código de recuperação novo se quiser.</p>
                    </details>
                    <details>
                      <summary>Falar com o suporte</summary>
                      <p>Copie os dados técnicos abaixo e envie junto com a sua dúvida. Eles não incluem senhas nem dados das suas ofertas.</p>
                      <button className="guide-link" onClick={() => void copySupportDetails().then(ok => { setCopied(ok); window.setTimeout(() => setCopied(false), 2500); })}>
                        {copied ? 'Copiado!' : 'Copiar dados para o suporte'} <ArrowRight size={15} />
                      </button>
                      {SUPPORT_URL && (
                        <a className="guide-download" href={SUPPORT_URL} target="_blank" rel="noreferrer">
                          Falar com o suporte
                        </a>
                      )}
                    </details>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {setupOpen && <LocalSetupModal onClose={() => setSetupOpen(false)} />}
    </div>
  );
}
