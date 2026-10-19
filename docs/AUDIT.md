# Auditoria da V1 de referência

Data: 15/10/2026. Escopo: leitura de `PromoBridge-Codex-Handoff/PROJECT`, handoff mestre e todos os documentos da especificação. A V1 foi preservada sem alterações. Esta auditoria descreve a referência original, não certifica a nova implementação.

## Baseline executado

Ambiente: Node.js 24.19.0, npm 11.9.0, Linux.

| Verificação | Resultado |
| --- | --- |
| `npm test` | 5 testes passaram; zero falhas |
| `npm run check` | 25 arquivos JavaScript passaram na verificação de sintaxe |
| Testes adicionais em memória, com transporte falso | Reproduziram reenvio indevido, validação fraca de produto, perda do preço atual e retorno de destino privado pelo resolvedor |

Os testes existentes cobrem extração básica de URL, detecção/ASIN Amazon, remoção de tracking, inclusão de tag e reescrita simples. Não cobrem WhatsApp real, banco/API, concorrência, SSRF, recuperação ou navegador. Não foi necessário instalar dependências para executar esse baseline. Não foram conectadas contas nem enviadas mensagens.

## Achados prioritários

1. **Resolvedor permite redirecionamento para rede privada.** `src/link-resolver.js:7-23` verifica apenas a URL inicial e usa `redirect: 'follow'`; não revalida os saltos nem o destino final. Uma resposta de transporte simulada com destino `http://127.0.0.1/private` foi aceita e devolvida. DNS falha aberto (`:44-45`), a resolução validada não é fixada na conexão e faltam políticas explícitas para IPv4 mapeado em IPv6, limites próprios de saltos e resposta. O timeout começa depois do DNS.

2. **Publicação não é idempotente nem respeita estados finais.** Em `src/pipeline.js:109-127`, o bloqueio é apenas um `Set` em memória por ID. Uma oferta já `sent` ignora a deduplicação e pode ser reenviada pelo endpoint de aprovação. Reproduzido: `send()` sobre item enviado e já publicado realizou outro envio. Um item `rejected` também foi enviado. A pausa global não é checada por `send()`. IDs diferentes do mesmo produto podem disputar a checagem antes do envio; não há reserva persistente/atômica do produto nem recuperação de `sending` após reinício.

3. **Afiliação não tem validação independente.** `src/pipeline.js:71-105` confia no resultado de geração. Seis lojas reutilizam diferenças de query em vez de integração específica; a calibração pode marcar `ready` com confiança média e sem prova de atribuição. Amazon aceita qualquer página com tag: reproduzido `applyAffiliate('https://www.amazon.com.br/s?k=casa', ...)` retornando `ok: true`, embora seja busca e não produto. Resolver/calibrador usam a URL recebida quando a resolução falha. Configurar `requireAffiliate: false` ainda permite preparar/publicar URL sem atribuição. Nenhuma loja tem validação real de conta/comissão demonstrada pelo pacote.

4. **Reescrita pode destacar preço incorreto.** `src/promotion-rewriter.js:18,38` usa o primeiro preço no estilo compacto. Para “De R$ 399,90 por R$ 299,90”, a saída reproduzida destacou somente R$ 399,90. O regex de percentual (`:4`) perdeu “25% de desconto” no mesmo ensaio. Mensagens com vários produtos reutilizam todo o texto original para cada URL, sem associação estruturada entre produto, preço e cupom.

5. **API local precisa de defesa de origem e validação mais forte.** `src/index.js` liga em `127.0.0.1`, uma boa proteção inicial. `src/api.js` não implementa autenticação local, verificação de `Origin`/`Host` ou CSRF; retorna toda a configuração. A configuração valida poucos campos e grava JSON diretamente, sem troca atômica. Controle remoto exigirá autenticação e canal seguro antes de ser exposto.

6. **Dependências não reproduzíveis.** `package.json` declara Baileys como `latest`, demais dependências com intervalos e não há lockfile na V1. Nenhum teste inicial verifica a combinação completa de dependências ou o SQLite no Windows.

7. **Curadoria e operação ainda são incompletas.** Ausentes: score explicável, perfil configurável de audiência, aprendizado persistente, horários e limites globais de publicação, sandbox explícito, migrations versionadas, backup/restore pela UI e recuperação da fila. Há pontos úteis a preservar: separação inicial de adaptadores, SQLite com WAL e índices, bind local, sessão fora do Git, mensagens próprias ignoradas e reconexão básica.

## Decisões recomendadas para a evolução

- Separar painel, worker persistente, core, adaptadores e persistência, com contratos TypeScript e validação de entrada.
- Bloquear publicação até identidade do produto, atribuição, deduplicação, conteúdo e política estarem validados. Falhas de resolução e lojas não suportadas seguem para revisão.
- Usar fila SQLite recuperável, reserva persistente por produto e tratamento explícito da incerteza quando o envio ocorre antes de uma falha de gravação.
- Manter sandbox demonstrável e distinguir evidência de fixture de validação real de WhatsApp/afiliados.
- Manter o worker em máquina persistente; Vercel pode hospedar painel/preview e não deve manter o socket WhatsApp.

## Disponibilidade de GitHub

`gh auth status` confirmou autenticação ativa como `cindygatop`, via `GH_TOKEN`, protocolo HTTPS. `gh api user` respondeu com sucesso; nenhum valor de token foi exposto. A consulta a `cindygatop/promobridge` retornou 404: o nome não corresponde a repositório acessível por essa credencial.

A CLI e a autenticação estão disponíveis, portanto criar repositório privado parece viável. Permissão efetiva de criação/escrita não é demonstrável com as consultas de leitura executadas; os headers não informaram escopos OAuth. Nenhum repositório foi criado durante esta auditoria.
