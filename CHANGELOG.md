# Alterações

## Recuperação de conta sem e-mail

- Cadastro com senha digitada duas vezes e 3 perguntas de segurança; respostas ignoram maiúsculas, minúsculas e acentos.
- Código de recuperação de 125 bits entregue em arquivo `.txt` no cadastro: uso único, guardado só como hash, trocado a cada recuperação e renovável em Minha conta.
- Novas rotas: `POST /api/v1/account/recover-with-code` e `POST /api/v1/account/recovery-code`; `recover-with-questions` passa a devolver o novo código.
- Reset de todas as contas anteriores (novos arquivos `auth-v2.json` e `security-questions-v2.json`; os antigos não são apagados).

## 2.0.0

- Monorepo TypeScript strict com painel React, worker persistente e contratos compartilhados.
- Painel em português com onboarding, simulação, fila, fontes, afiliação, audiência, automação, mensagens, saúde e backup.
- Resolvedor HTTPS com proteção de destinos privados em cada salto e DNS fixado no transporte.
- Validação independente de produto/afiliação; lojas sem mecanismo oficial implementado ficam bloqueadas.
- Score explicável, feedback persistente, horários, limites e políticas de repetição.
- SQLite versionado, reserva persistente de publicação e recuperação de envios incertos.
- Dependências fixadas, lockfile e testes de segurança, integração e painel.

A V1 original foi auditada e permanece no handoff. Seu commit inicial foi preservado no histórico do repositório.
