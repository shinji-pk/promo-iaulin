# Validação da versão 2.0.0

Verificado em 18/10/2026, com Node 24.19.0 e Chromium no Linux. Não foram conectadas contas reais de WhatsApp ou de programas de afiliados, nem enviadas mensagens externas.

| Verificação | Resultado |
| --- | --- |
| ESLint | Passou |
| TypeScript strict | Passou |
| Core, adaptadores, parser e score | 91 testes passaram |
| Segurança do resolvedor HTTPS | 86 testes passaram |
| Normalização e ciclo de vida do WhatsApp | 34 testes passaram |
| API e integração com SQLite real | 19 testes passaram |
| Banco, backup e recuperação | 5 testes passaram |
| Playwright, desktop e iPhone 13 | 8 testes passaram |
| Build de produção Vite | Passou |
| `npm audit`, dependências completas e de produção | Zero vulnerabilidades reportadas nas consultas executadas |

## Fluxo verificado no navegador

O usuário altera preferências na tela, envia pela API local com token CSRF, grava no SQLite e recupera os valores após recarregar. Também cola uma oferta, executa simulação, vê preço/score/motivo de bloqueio, registra rejeição e recupera a decisão persistida. O histórico não registra publicação real para uma simulação.

As onze páginas e o guia abrem em desktop e celular, sem erros JavaScript ou rolagem horizontal. A demonstração estática funciona quando a API não existe, persiste dados apenas naquele navegador e mantém o envio real desativado. Capturas foram inspecionadas para corrigir sobreposição no hero e representação do gráfico vazio; a linha de base não sugere publicações inexistentes.

Os testes de navegador usam um resolvedor de URL injetado somente no servidor de teste; isso mantém o cenário reproduzível sem acessar lojas. Os testes da API usam transporte WhatsApp controlado e SQLite real temporário. As suítes do resolvedor verificam DNS/IP, fixação do endereço, redirecionamentos, limites, timeouts, cabeçalhos e falhas fechadas, sem depender da rede externa.

## Proteções exercitadas

- Host e Origin não autorizados, token CSRF ausente/incorreto, conteúdo inválido e campos desconhecidos.
- Publicação manual e automática repetem as gates; mudar URL, tag, país, produto, conteúdo ou regras não libera envio inválido.
- Mensagem com mais de oito links produz um resumo explícito dos excedentes; a resolução tem orçamento total de vinte segundos.
- Mensagens próprias, históricas, de fontes não autorizadas e do grupo de destino são ignoradas.
- Reservas persistentes impedem concorrência por produto; interrupção ou confirmação ambígua vira `uncertain`, sem reenvio automático.
- Restaurar backup antigo preserva evidência dos envios posteriores e invalida marcadores de calibração.
- Simulações e feedback órfão não treinam o score de ofertas reais.

## Validação real ainda necessária

| Componente | Estado e dependência |
| --- | --- |
| Amazon | Geração e validação estrutural implementadas. Precisa de par real de links, tag pública da proprietária e confirmação de atribuição no programa. |
| Shopee, Mercado Livre, Magalu, AliExpress, SHEIN, Temu | Reconhecimento implementado; geração/prova de afiliação oficial ainda não implementadas. Publicação bloqueada. |
| WhatsApp | Código de conexão, QR, grupos, sessão, reconexão e envio implementado e testado com transporte controlado. Precisa de vínculo e teste real no computador. |
| Windows | Scripts preparados para Node 24, mas não executados em Windows neste ambiente. |
| Mídia | Envio de texto implementado; captura e reenvio de imagem/preview não implementados. |
| Controle remoto | Não implementado. Vercel hospeda a demonstração; worker local não fica exposto. |

As sete lojas não são declaradas prontas por existirem fixtures. Na instalação inicial, todas aguardam configuração. A calibração Amazon confere a estrutura do link e a continuidade do produto; não prova titularidade, aprovação da conta ou comissão paga.

## Reproduzir

```bash
npm ci
npm run check
npm run test:e2e
```

No Windows, se o Chromium não estiver instalado para o Playwright, execute `npx playwright install chromium` antes dos testes de navegador. Essa etapa é de desenvolvimento e não é necessária para abrir o painel normal.

## Integração do checkup do ambiente

O checkout inicial era a V1 incompleta. A revisão remota `5f20821`, recebida durante o checkup, restaurou o monorepo V2 e foi preservada integralmente. Seu lockfile continha entradas extrínsecas de esbuild para outras plataformas, causando `npm ci` com erro EBADPLATFORM no Linux. `npm install --package-lock-only --ignore-scripts` removeu essas entradas sem alterar versões declaradas nem checksums. Após isso, `npm ci`, `npm run check` (235 testes), os oito testes Playwright e a auditoria completa com zero vulnerabilidades passaram neste ambiente. A URL pública anunciada no GitHub é `https://promo-iaulin-mkce.vercel.app`; o acesso a ela e à API Vercel permanece bloqueado pela política de rede, portanto o deploy público não está confirmado.

O preview Vite também foi corrigido para não herdar o proxy da API de desenvolvimento. Antes, os dois cenários de demonstração falhavam quando um worker real já estava ativo em 3030, pois o preview conectava a ele. O preview agora representa a hospedagem estática e os mesmos testes verificam a demonstração sem alterar suas asserções, enquanto o worker continua disponível separadamente.
