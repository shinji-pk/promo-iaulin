# PromoBridge — Projeto Mestre

Este repositório contém a V1 do PromoBridge, um bot local para captar promoções em grupos autorizados do WhatsApp, identificar links de marketplaces, remover rastreamento/afiliação anterior quando possível, gerar o link afiliado da proprietária, reescrever a oferta e publicar no grupo de destino com o mínimo possível de trabalho manual.

## Princípio principal

A proprietária não programa. Configurações de uso cotidiano devem ser alteráveis pelo painel, não por edição de código: sessão/número do WhatsApp, grupos de origem, grupo de destino, plataformas, afiliação, regras de repetição, modo manual/automático e formato das mensagens.

## Fluxo desejado

1. O bot monitora os grupos-fonte selecionados.
2. Detecta mensagens de promoção e extrai links.
3. Resolve links encurtados/redirecionados.
4. Identifica marketplace e produto real.
5. Remove parâmetros de rastreamento e afiliação anterior.
6. Gera o link afiliado próprio daquele produto.
7. Valida que o produto continua correto e que a afiliação está configurada.
8. Evita duplicação usando histórico local.
9. Reescreve a mensagem com identidade própria.
10. Publica automaticamente quando seguro, ou envia para fila de revisão quando houver dúvida.

## Marketplaces previstos

- Amazon
- Shopee
- Mercado Livre
- Magalu
- AliExpress
- SHEIN
- Temu

Cada marketplace deve permanecer em módulo separado para facilitar correções futuras.

## Público e evolução do produto

O sistema será usado principalmente para curadoria de promoções relevantes para mulheres. A evolução planejada deve incluir score de relevância, qualidade da oferta, categorias configuráveis e aprendizado a partir de aprovações/rejeições, sem depender de estereótipos rígidos.

## WhatsApp

A V1 usa Baileys e conexão por QR Code. A sessão deve ficar fora do Git. Como é integração não oficial, existe risco de restrição/bloqueio; recomenda-se número separado para o bot.

## Hospedagem

- GitHub: repositório completo e privado.
- Vercel: painel/preview web.
- Worker do WhatsApp: processo persistente no PC ou VPS; não deve depender de Vercel Functions para manter a conexão 24/7.

## Dados

SQLite local para histórico, fila, deduplicação e auditoria. Mídias pesadas não devem ser armazenadas sem necessidade. Retenção/limpeza deve ser configurável.

## Segurança

Nunca commitar sessão do WhatsApp, banco local, cookies, tokens ou credenciais. Nunca pedir senha, SMS ou 2FA de marketplace. Links devem ser validados antes da publicação.

## Estado desta V1

A base atual inclui painel local, configuração, fila, SQLite, pipeline, integração WhatsApp, resolvedor de links, reescrita de mensagens e módulos separados por marketplace. Alguns marketplaces ainda exigem calibração/integração específica com os dados reais de afiliado antes de publicação automática confiável.

O objetivo de futuras versões é reduzir ao mínimo a intervenção manual e manter uma interface bonita, moderna, limpa, responsiva para iPhone e desktop.
