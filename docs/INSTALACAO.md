# Instalação do Promo Iaulin no Windows

## Para quem vai usar o aplicativo

A versão para clientes é o instalador **Promo-Iaulin-Setup.exe**, disponível na seção [Releases](https://github.com/shinji-pk/promo-iaulin/releases) quando a compilação de teste do Windows estiver concluída. Os lançamentos marcados como **prévia** ainda exigem validação em uma máquina Windows real.

1. Em Releases, abra a versão de teste mais recente e baixe **Promo-Iaulin-Setup.exe**.
2. Abra o instalador e siga o assistente com a identidade visual do Promo Iaulin. A instalação é por usuário, sem precisar de permissão de administrador.
3. Abra **Promo Iaulin** pelo atalho. A janela exibe o progresso de inicialização e um botão **Conectar WhatsApp**.
4. No seu celular, abra WhatsApp → Dispositivos conectados → Conectar dispositivo e leia o QR Code do painel.
5. Escolha grupos de origem e destino. Mantenha o aplicativo ativo enquanto quiser receber/publicar promoções.

**Não é necessário baixar repositório ZIP, abrir CMD, instalar Node.js, executar PowerShell ou compilar arquivos no computador do usuário.** O instalador já contém o Node.js e os arquivos compilados. A conexão com internet ainda é necessária para o WhatsApp e outras integrações. A janela pode ser fechada para minimizar na área de notificação, perto do relógio. Para encerrar o serviço, use **Encerrar Promo Iaulin** no ícone da área de notificação.

## Dados e privacidade

- Os dados de uma instalação nova ficam em \`%LOCALAPPDATA%\Promo Iaulin\data\`.
- Os executáveis ficam separados em \`%LOCALAPPDATA%\Programs\Promo Iaulin\`. Atualizar ou desinstalar não apaga os dados do usuário automaticamente.
- Se já usou o ZIP antigo, seus dados continuam em \`data\` dentro da pasta antiga. Não descarte a pasta sem antes fazer backup. A cópia para a pasta nova deve ser feita **somente com todos os processos antigos e novos fechados**, e nunca se deve executar duas cópias com a mesma sessão WhatsApp.
- Não envie a pasta de sessão, o backup ou chaves de API a terceiros.
- O instalador de teste ainda **não possui assinatura digital**. Por isso o SmartScreen pode avisar que o editor é desconhecido; isso não é uma prova de vírus nem uma confirmação de segurança. Confira origem e o hash SHA-256 publicado no build e mantenha o antivírus ativo. É recomendado assinar digitalmente o programa e obter reputação SmartScreen antes da distribuição comercial ampla.
- O WhatsApp é conectado por meio de Baileys, uma integração não oficial. Pode haver limitações ou restrições aplicadas pelo próprio serviço. Prefira número separado.

## Por que o site sozinho não é suficiente atualmente?

O site hospedado na Vercel guarda a conta, as preferências e simulações. A leitura contínua das mensagens de grupos e o envio dependem de um processo WhatsApp que permaneça ligado. Na arquitetura atual, esse processo é executado pelo Promo Iaulin instalado no computador. Vercel Functions têm duração limitada e não são um serviço que permaneça ativo indefinidamente.

É tecnicamente possível criar um gateway WhatsApp hospedado continuamente em um servidor dedicado, mostrando QR Code diretamente no site e dispensando a instalação local. Isso exigiria outro projeto de infraestrutura, custeio, gestão de sessões criptografadas, isolamento entre contas, rotinas de reinício e conformidade com as políticas do WhatsApp. Não está implementado neste lançamento.

## Para desenvolver e dar manutenção

O fluxo antigo com ZIP, \`INICIAR-PROMOBRIDGE.bat\`, \`scripts/iniciar-windows.ps1\` e \`npm run check\` continua no repositório para desenvolvimento e manutenção, **não é o fluxo recomendado a clientes**.

A automação de empacotamento fica em \`.github/workflows/windows-installer.yml\`. É executada em um runner Windows, prepara o Node.js 24, roda os testes, gera a arte, compila um lançador WinForms .NET autocontido, copia apenas os componentes de produção e compila o instalador com Inno Setup. O arquivo instalável é disponibilizado como artefato; em pushes para main, o workflow publica uma prévia nos Releases.

### Verificações antes de aprovar um lançamento estável

1. Conferir que o build no GitHub Actions foi concluído sem erros e que o instalador aparece no artifact ou pré-lançamento.
2. Em Windows 10 e 11 x64 limpos, instalar com usuário sem privilégio administrativo. Validar atalho, ícone, janela de inicialização, abertura da página local, parada e retomada pelo ícone da bandeja.
3. Vincular WhatsApp com uma conta de teste real por QR Code, conferir listagem de grupos, reconexão e comportamento ao minimizar e encerrar.
4. Confirmar que reinstalar preserva o banco e que o desinstalador não remove a sessão nem as configurações.
5. Confirmar que nenhuma janela de CMD, PowerShell ou prompt de instalação do Node aparece para o cliente.
6. Assinar o instalador e o aplicativo com certificado apropriado e publicar uma versão estável somente após a validação.

### Falhas comuns

- **Programa não inicia:** feche cópias antigas do PromoBridge, especialmente o CMD do ZIP antigo, porque a porta 3030 é usada por apenas uma instância.
- **Janela mostra falha de inicialização:** verifique a integridade da instalação, antivírus e disponibilidade da porta 3030. Use **Tentar novamente**.
- **QR Code não aparece:** confira a conexão de internet e clique em **Conectar WhatsApp** no painel local.
- **Quero abrir o painel:** com o Promo Iaulin em execução, abra \`http://127.0.0.1:3030/\` ou clique em **Abrir meu painel**.
