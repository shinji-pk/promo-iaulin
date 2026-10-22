# PromoBridge

Seu espaço de curadoria de promoções: captar, entender, selecionar, revisar e compartilhar ofertas com afiliação validada.

O painel está em português e reúne fila, simulação, lojas, público, fontes, regras, identidade das mensagens, atividade e backup. As configurações do uso diário ficam na interface.

## Instalar no Windows (experiência para usuários)

1. Abra [**Releases do Promo Iaulin**](https://github.com/shinji-pk/promo-iaulin/releases) e selecione uma versão de teste disponível para Windows x64.
2. Baixe **`Promo-Iaulin-Setup.exe`** e conclua o assistente de instalação.
3. Abra **Promo Iaulin** no menu Iniciar ou pela área de trabalho. Não é necessário extrair ZIP, instalar Node.js, usar PowerShell ou abrir CMD.
4. Clique **Conectar WhatsApp**, abra **Dispositivos conectados** no WhatsApp do celular e leia o QR Code exibido no painel.

O instalador inclui o mecanismo do app, o Node.js necessário e as dependências já preparadas. Não baixa nem compila componentes no PC do cliente. O programa tem janela e ícone próprio e pode ser minimizado para a área de notificações; para encerrar o bot, use **Encerrar Promo Iaulin** no menu do ícone perto do relógio. Fechar a aba do navegador não encerra o serviço.

A compilação automática para Windows está em `.github/workflows/windows-installer.yml`. **As versões iniciais são prévias de teste, não lançamentos finais validados em todos os computadores.** Sem assinatura digital, o Windows SmartScreen poderá mostrar um aviso. Não é necessário desativar o antivírus. A assinatura Authenticode deve ser adicionada antes de uma distribuição comercial ampla.

O aplicativo mantém banco de dados, sessões e credenciais sob **`%LOCALAPPDATA%\\Promo Iaulin\\data`**, separado dos arquivos instalados. Reinstalar ou desinstalar não apaga automaticamente essa pasta. Uma instalação antiga iniciada por ZIP guardava o banco na subpasta `data` da pasta extraída; migrações devem ser feitas com ambas as cópias fechadas e um backup prévio. Consulte o [guia de instalação](docs/INSTALACAO.md).

**Dá para conectar só com o QR Code, sem instalar nada?** Sim. Ative uma vez o servidor do WhatsApp na nuvem e o QR Code aparece direto no site: veja [QR na nuvem](docs/QR-NA-NUVEM.md). Isso é necessário porque a conexão do WhatsApp é de longa duração e não funciona nas funções temporárias da Vercel. O aplicativo para Windows continua disponível como alternativa.

## Desenvolvedores

O fluxo antigo com `INICIAR-PROMOBRIDGE.bat` e ZIP do código-fonte permanece como alternativa de desenvolvimento, não como instalação indicada a usuários finais. Para contribuir, siga as instruções de build e testes abaixo.

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

Em **https://iaulinbot.vercel.app**, use **Criar conta** ou **Entrar**. Este é o endereço recomendado para novos acessos; contas antigas de outro projeto Vercel não são migradas automaticamente. Nome, e-mail, preferências, simulações e o último estado sincronizado ficam no armazenamento privado do servidor, separados por usuário. Sair ou trocar de navegador não apaga esses dados. A conta não usa localStorage como banco.

A senha tem pelo menos 6 caracteres; o painel permite alterá-la e sair.

**Recuperar a senha sem e-mail.** Ao criar a conta, a pessoa digita a senha duas vezes, escolhe **3 perguntas de segurança** e recebe um arquivo **`.txt` com um código de recuperação**. Se esquecer a senha, em **Esqueci minha senha** ela usa um dos dois caminhos:

- **Código de recuperação:** e-mail + o código do arquivo + nova senha. O código vale uma única vez; ao usá-lo, o sistema mostra outro para baixar.
- **Três perguntas:** e-mail + as três respostas + nova senha. Maiúsculas, minúsculas, acentos e espaços extras não importam.

As respostas e o código ficam guardados de forma permanente no armazenamento privado do servidor, mas **somente como impressão digital irreversível** (HMAC-SHA256 com a chave do servidor; as respostas ainda passam pelo hash de senha do Better Auth): nem a equipe consegue lê-los. Por isso o código só aparece uma vez. Quem perder o arquivo gera outro em **Minha conta → Meu código de recuperação** (exige a senha; o antigo deixa de valer). Qualquer recuperação bem-sucedida encerra todas as sessões abertas e troca o código. Limites: 3 tentativas por hora nas perguntas e 10 por hora no código, por e-mail. Verificação de e-mail e link por e-mail só funcionam se o envio de e-mails for configurado; a recuperação acima não depende disso.

**Reset de contas (20/10/2026).** Todas as contas anteriores deixaram de ser lidas (o sistema passou a usar `accounts/auth-v2.json` e `accounts/security-questions-v2.json`); todos precisam criar a conta de novo, já com as perguntas e o código. Os arquivos antigos (`auth-v1.json` e as pastas `accounts/<id>/`) continuam intactos no Vercel Blob privado até alguém apagá-los.

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
