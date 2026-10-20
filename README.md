# PromoBridge

Seu espaço de curadoria de promoções: captar, entender, selecionar, revisar e compartilhar ofertas com afiliação validada.

O painel está em português e reúne fila, simulação, lojas, público, fontes, regras, identidade das mensagens, atividade e backup. As configurações do uso diário ficam na interface.

## Começar no Windows

1. Baixe o repositório e **extraia a pasta inteira** no computador.
2. Abra **`INICIAR-PROMOBRIDGE.bat`** na pasta extraída. Na primeira vez, aguarde a preparação com internet.
3. O painel abre em **http://localhost:3030**. Você pode fechar a aba do navegador: o bot continua operando enquanto o PromoBridge estiver em execução no computador.
4. Siga o guia do painel. Comece em modo manual e use **Simular oferta** para conhecer o fluxo.

O iniciador prepara uma cópia portátil do **Node.js 24.19.0** dentro da pasta do aplicativo, conferida com o SHA-256 publicado em [nodejs.org](https://nodejs.org/download/release/v24.19.0/SHASUMS256.txt). Não exige instalação global do Node nem acesso de administrador. Nas próximas vezes, abra o mesmo arquivo; a preparação só é repetida quando necessário. Os atalhos antigos em `scripts/` continuam funcionando.

Não é necessário editar código, JSON, banco ou arquivos de configuração. O computador precisa ficar ligado para receber e publicar ofertas. Não execute duas cópias do aplicativo para a mesma sessão. Consulte [instalação e solução de problemas](docs/INSTALACAO.md).

## Configurar pelo painel

- **Fontes:** conecte o WhatsApp pelo QR Code, selecione os grupos-fonte e um destino pela lista de nomes. Use um número separado e grupos que autorizaram o monitoramento.
- **Lojas & afiliados:** configure sua identificação, conectores disponíveis ou biblioteca de links oficiais por produto. Nunca informe senha, SMS, 2FA ou cookies.
- **Audiência:** ajuste categorias e palavras bloqueadas. Categorias com peso zero ficam desativadas.
- **Automação:** escolha modo, score mínimo, frequência, horário silencioso, fuso e repetição. Uma pausa bloqueia os envios sem apagar a sessão.
- **Mensagens:** escolha estilo, convite e assinatura. Confira a prévia de cada oferta.
- **Configurações:** baixe/restaure backup e ajuste retenção.

As configurações e a sessão persistem entre reinicializações. **Fechar o site ou desligar o computador não apaga os dados já salvos.** Para receber e publicar pelo WhatsApp, o computador precisa estar ligado com o processo PromoBridge funcionando; o navegador pode ser fechado. Enquanto o processo estiver parado, novas mensagens podem não ser capturadas. Ao abrir novamente o aplicativo, uma sessão salva é retomada automaticamente se ainda for válida. Se ela tiver expirado, use **Conectar WhatsApp** no painel para obter um novo QR. A reconexão após quedas transitórias é automática e tem limite de tentativas.

## O que esta versão faz

- Extrai múltiplos links, preços brasileiros, cupom e frete explicitamente informados; separa ofertas quando a associação entre texto e link é clara.
- Resolve URLs HTTPS com validação DNS/IP e de cada redirecionamento, timeout e limites de cabeçalho; não baixa o corpo das páginas.
- Reconhece produtos de sete marketplaces em adaptadores separados.
- Reescreve mensagens sem IA paga, mostra score e confiança explicáveis e usa feedback real de forma conservadora.
- Persiste fila, atividade e feedback em SQLite; impede reenvio concorrente, revalida regras antes da publicação e retém envios de confirmação incerta para conferência.
- Executa simulações sem envio ao WhatsApp. Elas ficam identificadas e não contam como publicação real.

## Contas e painel online

Em **https://promo-iaulin.vercel.app**, use **Criar conta** ou **Entrar**. Nome, e-mail, preferências, simulações e o último estado sincronizado ficam no armazenamento privado do servidor, separados por usuário. Sair ou trocar de navegador não apaga esses dados. A conta não usa localStorage como banco.

A senha tem pelo menos 12 caracteres; o painel permite alterá-la e sair. Envio de e-mail de recuperação e verificação de e-mail ainda não foram configurados. Guarde sua senha com cuidado.

O computador continua executando a conexão WhatsApp e a fila persistente. Para controlá-lo pelo site: no painel local, abra **Fontes & conexões → Acessar pelo celular**, ative o acesso e copie o link de pareamento. No site, abra o avatar **Minha conta**, expanda **Passo a passo para conectar** e cole o link. Ele é válido por cinco minutos e consumido uma vez; o acesso de dispositivo dura oito horas. O túnel temporário muda ao reiniciar e não tem garantia de disponibilidade. Um túnel próprio pode ser configurado para endereço estável.

O botão flutuante **Guia do meu grupo** explica o passo a passo, todas as áreas e as dúvidas comuns. O tema usa letras maiores, controles confortáveis e contraste reforçado.

## Integrações e operação

- **Amazon:** tag e ASIN estruturalmente validados; conector opcional para Creators API com credenciais da sua conta. A estrutura do link não comprova titularidade nem pagamento de comissão.
- **Shopee e AliExpress:** conectores de API configuráveis com teste por produto. Disponibilidade, permissões e atribuição precisam ser confirmadas na conta real do programa. O contrato Shopee precisa dessa validação porque parte da documentação fica atrás do acesso de afiliado.
- **Mercado Livre, Magalu, SHEIN e Temu:** biblioteca de pares exatos entre produto e link gerado no portal oficial. A titular declara que conferiu produto e conta; cada publicação exige aprovação manual ou agendamento explícito. Não há conversão genérica inventada nem comissão presumida.
- **Fila:** entrada manual, correção de dados, reprocessamento, aprovação, agendamento, validade, deduplicação, silêncio, frequência e retomada automática quando a janela abrir. Confirmações ambíguas ficam retidas para conferência manual, sem reenvio automático.
- **Mídia:** miniaturas JPEG incorporadas e limitadas podem acompanhar a mensagem. Não baixa imagens arbitrárias; mensagens maiores que a legenda permitida seguem em texto, sem repetir um envio de imagem que tenha falhado.

As credenciais de API ficam no cofre criptografado do computador e só podem ser cadastradas no painel local. Não são senhas de marketplace. Sessão, chaves e recibos de confiança não entram no backup público. Nenhuma URL afiliada de saída é aberta automaticamente para gerar um clique de verificação.

**WhatsApp:** Baileys é uma integração não oficial. Vínculo, grupos, permissão para publicar e um envio real precisam ser validados com seu número. Não foram usadas contas reais das lojas nem enviadas mensagens externas nos testes automatizados.

**Curadoria:** preço, frete e cupom são extraídos da mensagem. O score é determinístico e explicável; não confirma estoque, reputação, cupom ou menor preço de mercado. Os ganhos são acompanhados no portal oficial de cada loja.

## Desenvolvimento

Requer Node 24 e npm. Dependências com versões fixadas e lockfile.

```bash
npm ci
npm run check
npm run dev
```

Interface de desenvolvimento em `http://localhost:5173`; API em `http://localhost:3030`. Para executar o build final:

```bash
npm run build
npm start
```

`npm run test:e2e` verifica o painel no Chromium; veja a configuração do Playwright. As suítes de unidade e integração não precisam de uma conta real de WhatsApp ou afiliados.

## Documentação

- [Arquitetura e limitações](docs/ARQUITETURA.md)
- [Auditoria da V1](docs/AUDIT.md)
- [Segurança](SECURITY.md)
- [Privacidade](PRIVACY.md)
- [Status de validação](docs/VALIDACAO.md)

Sessão, bancos, logs e backups locais ficam fora do Git. Guarde backups em local privado; eles podem conter nomes de grupos e textos de ofertas.

## Minha conta e recuperação de senha

No painel, a área **Minha conta** permite editar nome, nome de usuário (apenas para exibição), telefone de contato não verificado e foto (até 140 KB); também permite solicitar troca de e-mail com confirmação e alterar a senha. A tela de acesso oferece **Esqueci minha senha** e redefinição com token temporário. É necessário configurar `RESEND_API_KEY` e `RESEND_FROM_EMAIL` (remetente validado) na Vercel antes que e-mails de recuperação e troca de e-mail possam ser enviados. Enquanto o provedor estiver ausente, o aplicativo informa que o envio não está disponível, sem simular sucesso. Mudança de senha não apaga preferências ou dados persistidos.
