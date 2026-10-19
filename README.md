# PromoBridge

Seu espaço de curadoria de promoções: captar, entender, selecionar, revisar e compartilhar ofertas com afiliação validada.

O painel está em português e reúne fila, simulação, lojas, público, fontes, regras, identidade das mensagens, atividade e backup. As configurações do uso diário ficam na interface.

## Começar no Windows

1. Instale o **Node.js 24 LTS** em [nodejs.org](https://nodejs.org).
2. Baixe o repositório e extraia a pasta no computador.
3. Abra `scripts/01-INSTALAR.bat`. Aguarde a instalação terminar.
4. Abra `scripts/02-ABRIR-PAINEL.bat`. Mantenha a janela do aplicativo aberta enquanto estiver usando.
5. Siga o guia do painel em **http://localhost:3030**. Comece em modo manual e use **Simular oferta** para conhecer o fluxo.

Depois da instalação inicial, basta abrir `02-ABRIR-PAINEL.bat`. Não é necessário editar código, JSON, banco ou arquivos de configuração. O computador precisa ficar ligado para receber e publicar ofertas. Não execute duas cópias do aplicativo para a mesma sessão.

## Configurar pelo painel

- **Fontes:** conecte o WhatsApp pelo QR Code, selecione os grupos-fonte e um destino pela lista de nomes. Use um número separado e grupos que autorizaram o monitoramento.
- **Lojas & afiliados:** informe sua identificação pública e um par de links do mesmo produto. Nunca informe senha, SMS, 2FA ou cookies.
- **Audiência:** ajuste categorias e palavras bloqueadas. Categorias com peso zero ficam desativadas.
- **Automação:** escolha modo, score mínimo, frequência, horário silencioso, fuso e repetição. Uma pausa bloqueia os envios sem apagar a sessão.
- **Mensagens:** escolha estilo, convite e assinatura. Confira a prévia de cada oferta.
- **Configurações:** baixe/restaure backup e ajuste retenção.

As configurações e a sessão persistem entre reinicializações. Ao abrir novamente o aplicativo, uma sessão salva é retomada automaticamente. Se ela tiver expirado, use **Conectar WhatsApp** no painel para obter um novo QR. A reconexão após quedas transitórias é automática e tem limite de tentativas.

## O que esta versão faz

- Extrai múltiplos links, preços brasileiros, cupom e frete explicitamente informados; separa ofertas quando a associação entre texto e link é clara.
- Resolve URLs HTTPS com validação DNS/IP e de cada redirecionamento, timeout e limites de cabeçalho; não baixa o corpo das páginas.
- Reconhece produtos de sete marketplaces em adaptadores separados.
- Reescreve mensagens sem IA paga, mostra score e confiança explicáveis e usa feedback real de forma conservadora.
- Persiste fila, atividade e feedback em SQLite; impede reenvio concorrente, revalida regras antes da publicação e retém envios de confirmação incerta para conferência.
- Executa simulações sem envio ao WhatsApp. Elas ficam identificadas e não contam como publicação real.

## Limites que precisam ficar claros

**Amazon:** implementada validação estrutural de ASIN, marketplace e tag pública mediante calibração. Ela verifica a forma do link e a continuidade do produto; não comprova titularidade da conta, aprovação pelo programa nem comissão paga. Valide um envio real e confira a atribuição no programa antes de ativar a automação.

**Shopee, Mercado Livre, Magalu, AliExpress, SHEIN e Temu:** identificação de produto implementada; geração oficial e prova de atribuição ainda dependem de integrações específicas. A publicação dessas lojas fica bloqueada. O sistema não inventa regras de comissão a partir de parâmetros de URL.

**WhatsApp:** conexão por Baileys, não oficial, com risco de restrição/bloqueio. Os testes usam mensagens e transporte controlados; o vínculo com seu número e o envio real precisam ser validados na sua máquina. Mensagens antigas, próprias e do destino são ignoradas. A versão envia texto; captura/reenvio de mídia e previews de produto são evoluções futuras.

**Curadoria:** score determinístico e ajuste limitado por feedback, sem classificador treinado. Preço, cupom e frete vêm da mensagem recebida; não há consulta oficial de estoque, reputação, histórico de mercado ou confirmação de cupom.

## Painel no Vercel

O build publicado é uma **demonstração isolada no navegador**, identificada na tela. Você pode experimentar a simulação e as preferências. Ela não controla seu PC nem conecta o WhatsApp; dados de demonstração ficam nesse navegador.

O worker local escuta somente em `127.0.0.1`. Controle remoto real ainda exige um backend persistente com autenticação e canal seguro. Não exponha a API local à internet e não tente manter a sessão do WhatsApp em Vercel Functions.

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
