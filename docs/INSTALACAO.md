# Instalação do aplicativo local

No Windows de 64 bits, baixe o ZIP do repositório e use **Extrair tudo**. Abra `INICIAR-PROMOBRIDGE.bat` dentro da pasta extraída. Não execute os arquivos diretamente de dentro do ZIP.

Na primeira execução, o iniciador:

1. Baixa o Node.js 24.19.0 para a arquitetura do computador, x64 ou ARM64, de `https://nodejs.org/download/release/v24.19.0/`.
2. Confere o SHA-256 do ZIP com o arquivo `SHASUMS256.txt` do mesmo site oficial, antes de extrair ou executar o Node.
3. Instala as dependências fixadas no `package-lock.json` e compila o painel e o worker.
4. Inicia o aplicativo local e abre o navegador quando a API responde.

Tudo fica na pasta extraída. O iniciador não instala Node globalmente, não exige administrador e não executa scripts baixados. A preparação inicial precisa de internet e pode levar alguns minutos. Windows PowerShell 5.1 ou posterior precisa estar disponível; ele já acompanha versões atuais do Windows.

Nas próximas execuções, basta abrir o mesmo arquivo. O iniciador confere se o código e as dependências mudaram e reaproveita a preparação concluída. Se o aplicativo já estiver aberto, ele abre o painel existente. Mantenha a janela aberta durante o uso; para encerrar, pressione **Ctrl+C** nela.

O painel local fica em `http://localhost:3030`. O WhatsApp precisa ser conectado pelo QR Code do painel. A sessão e os dados ficam em `data/`, preservados ao fechar e abrir o aplicativo. O computador precisa permanecer ligado e conectado para receber e publicar ofertas.

## Atalhos compatíveis

- `scripts/01-INSTALAR.bat`: prepara o aplicativo sem iniciar o worker.
- `scripts/02-ABRIR-PAINEL.bat`: prepara, se necessário, e abre o aplicativo.
- `scripts/03-VERIFICAR.bat`: prepara as dependências e executa as verificações do projeto.

Todos usam o mesmo iniciador e a mesma cópia portátil do Node. O diretório `.runtime/` contém somente a preparação local; não precisa ser incluído no backup dos seus dados.

## Problemas comuns

**Não abre ou informa arquivo ausente:** extraia o ZIP inteiro em uma pasta gravável. Caminhos com espaços são aceitos. Evite pastas temporárias ou uma pasta protegida do sistema.

**Download interrompido:** confira a internet e abra o iniciador novamente. Se a verificação SHA-256 falhar, o ZIP recebido é descartado e não é executado.

**Erro do npm ou da compilação:** leia a mensagem imediatamente acima do erro final. O iniciador mantém o código de saída e não indica sucesso se uma etapa falhar. Confira internet, espaço livre e se o antivírus colocou algum arquivo em quarentena. Não desative a proteção do sistema.

**Outra janela já está preparando o aplicativo:** aguarde a janela anterior. A preparação e a execução usam um bloqueio para evitar duas cópias da mesma pasta ao mesmo tempo.

**Outro programa usa a porta 3030:** feche esse programa ou a outra cópia do PromoBridge e tente novamente. O aplicativo não encerra outros programas automaticamente.

**Node local danificado:** feche o aplicativo e apague somente `.runtime/`. Abra o iniciador novamente para refazer a preparação. Preserve `data/`, que contém configurações, histórico e sessão do WhatsApp.

**Atualização:** encerre o worker, faça um backup pelo painel e substitua os arquivos do programa, preservando `data/`. Abra novamente o iniciador; ele detecta as alterações e recompila. Não copie uma sessão em uso para executar dois workers simultaneamente.

## macOS, Linux e desenvolvimento

Instale Node.js 24 LTS e use `scripts/iniciar.sh`, ou execute:

```bash
npm ci --include=dev
npm run build
npm start
```

O build emite JavaScript para `dist/worker/`. `npm start` executa esse JavaScript com o Node; o worker de produção não depende do `tsx`. Para atualizar o código, execute o build novamente antes de iniciar.

O iniciador Windows exige uma validação final em um computador Windows. A compilação e os testes do worker podem ser executados separadamente em Linux; eles não comprovam a instalação do Windows nem a conexão com uma conta real de WhatsApp.
