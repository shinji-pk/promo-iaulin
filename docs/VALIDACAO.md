# Validação 2.1.0

Verificações em 19/10/2026, com Node 24.19.0 e Chromium no Linux. Contas reais de WhatsApp/lojas não foram vinculadas e nenhuma mensagem externa foi enviada.

| Verificação | Resultado |
| --- | --- |
| ESLint e TypeScript strict | Passaram |
| Vitest: core, URLs, banco, APIs, providers, cofre, WhatsApp, contas e proxy | 429 testes passaram |
| Playwright desktop e iPhone 13 | 10 testes passaram |
| Build Vite e JavaScript compilado do worker | Passaram |
| npm audit completo e de produção | Zero vulnerabilidades reportadas |

## Fluxos exercitados

- Cadastro, login e logout com Better Auth real; duas contas com preferências e simulações separadas; recuperação após nova instância do servidor. Cookies, CSRF, origem, senha incorreta, concorrência, unicidade, rollback e troca de senha com revogação/renovação de cookie.
- Pelo navegador: criar conta, salvar assinatura no servidor, recarregar, sair, entrar e recuperar o valor. Guia flutuante, navegação, preferências, simulação e revisão em desktop/celular. Telas e fontes maiores inspecionadas por captura e sem rolagem horizontal nos cenários testados.
- APIs com SQLite real e transporte controlado: entrada manual, correção, reprocessamento, agendamento, pausa/retomada, expiração, revisão humana, histórico e reconciliação de envio incerto. Preflight antes da reserva, sem repetição de uma tentativa ambígua.
- APIs de afiliados com respostas controladas: vínculo exato de produto, configuração e credencial; mudança de conta durante a chamada; timeout; biblioteca manual; invalidação de provas e ausência de segredos em respostas/backups. Nenhuma URL afiliada de saída visitada.
- WhatsApp controlado: QR/ciclo de vida, grupos/permissões, mensagens próprias/históricas, normalização, miniatura JPEG limitada, imagem/texto sem retry duplicado e identificação de envio.
- Acesso remoto controlado: códigos de uso único, expiração, revogação, reinício, host exato, cookie/CSRF e bloqueio de administração por cabeçalhos encaminhados. Proxy com TLS/DNS fixado, redes privadas, redirecionamentos, limites, tipos de conteúdo e cookie criptografado por usuário.

Os testes de contas usam backend CAS controlado com a biblioteca de autenticação real. A publicação exige também a verificação do armazenamento privado e das rotas no ambiente Vercel; os resultados finais desse smoke são registrados junto à publicação. Fixtures e testes controlados não equivalem a aprovação em programas de afiliados.

## Dependências de uso real

| Área | O que falta configurar ou confirmar |
| --- | --- |
| WhatsApp | Ler o QR com o número da titular, escolher grupos, conferir permissão e uma publicação real |
| APIs Amazon/Shopee/AliExpress | Credenciais e permissões da conta; testar produto real e atribuição no programa |
| Demais lojas | Gerar e importar pares oficiais por produto, conferir titularidade/produto e aprovar cada envio |
| Windows | Iniciador preparado e estrutura compilada verificada em Linux; validação final em Windows ainda necessária |
| Túnel | Testes usam processo controlado; a conexão Cloudflare real depende da rede/conta da titular |
| Recuperação por e-mail | Provedor não configurado; não há promessa de envio de recuperação/verificação |

O backend de contas usa documentos privados com limite de 8 MiB, adequado ao pequeno volume inicial. A cópia online é limitada a 3.000 ofertas/300 atividades; o histórico completo permanece no worker conforme retenção. Ver arquitetura para migração futura a Postgres.

## Reproduzir

```bash
npm ci
npm run check
npm run test:e2e
```

Playwright precisa do Chromium instalado no ambiente de desenvolvimento. A operação normal do aplicativo não depende dos testes nem de credenciais em arquivos de código.

## Histórico do checkup de instalação

As revisões remotas 1c15d6c e 246f05b corrigiram o checkout incompleto, entradas extrínsecas do lockfile que causavam EBADPLATFORM no Linux e o proxy herdado pelo preview estático. Essas correções foram integradas antes da versão 2.1. A presente versão mantém o preview sem proxy e usa dependências e o mesmo commit libsignal por tarball HTTPS, evitando exigir Git/SSH no iniciador portátil.
