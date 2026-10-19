# Contas pessoais e persistência no Vercel

Pesquisa de 18/10/2026 (horário de Brasília). Documento de arquitetura e viabilidade; nenhum recurso de armazenamento ou provedor foi criado/instalado.

## Recomendação

O caminho principal é **Better Auth + Postgres transacional**, hospedando o handler de autenticação e as rotas de dados em Vercel Functions no mesmo domínio do painel. Neon pela integração Vercel Marketplace é a opção natural. As configurações devem ter `user_id`/`owner_id` do servidor e não depender de um identificador enviado pelo navegador.

O projeto examinado ainda é publicado como Vite estático (`apps/web/dist`). A API Express existente roda no worker local, porta 3010, e o frontend troca para demonstração quando a API hospedada retorna 404. Criar somente uma tela de login manteria essa limitação. O novo fluxo precisa de autenticação real, uma API hospedada e armazenamento remoto persistente, com teste entre navegadores e deployments.

O uso de SQLite no computador pode fornecer contas locais válidas, mas não satisfaz sozinho o requisito de conta no site Vercel. `/tmp` ou o filesystem de uma Function também não são banco persistente.

## Ferramentas conectadas realmente disponíveis

Inspeção do catálogo `ALL_TOOLS`, sem inventar operações não expostas:

| Operação | Tool disponível | Observação |
|---|---|---|
| Criar Blob store | `mcp__codex_apps__vercel_create_storage_stores_blob` | `requestBody: { name, access: 'private', projectId?, region? }`; `teamId?` opcional. |
| Consultar store conhecido | `mcp__codex_apps__vercel_get_storage_stores_by_id` | Necessita `id`; não é listagem geral de stores. |
| Consultar integrações | `mcp__codex_apps__vercel_list_integration_configurations` | `view: 'account' | 'project'`; filtros opcionais de integração e escopo. |
| Consultar produtos de instalação | `mcp__codex_apps__vercel_list_integration_configuration_products` | Exige ID de instalação já existente. |
| Consultar planos | `mcp__codex_apps__vercel_list_integration_billing_plans` | Somente leitura; não cria recurso nem instalação. |
| Criar instalação Marketplace | **Não exposta** | Nenhuma tool de create/install integration foi encontrada. |
| Criar Neon/Postgres/Upstash | **Não exposta** | Nenhuma tool nativa de provisionamento desses bancos foi encontrada. |

Nesta sessão, as chamadas sem `teamId` a `list_integration_configurations({view:'project'})` e `({view:'account'})` retornaram `result: []`. Isso prova o resultado observado pelo conector, não a inexistência de todos os recursos em todas as contas/escopos.

O root relatou que o CLI Vercel 64.5.0 pede login até para descoberta de integração. Sem credencial de CLI configurada, a existência do conector MCP não autentica automaticamente o CLI. Não copiar tokens do conector nem tentar usar OIDC de deployment como token administrativo Marketplace.

**Consequência prática:** o provisionamento transacional preferido precisa de acesso efetivo ao CLI ou da instalação Neon no dashboard. Não existe uma chamada MCP de Neon disponível que esteja apenas faltando descobrir neste catálogo. O fallback Blob pode ser provisionado pela tool acima, sujeito à decisão do responsável e às condições de cobrança; este documento não o fez.

## Better Auth com Express e Vite

Better Auth é independente de framework e possui integração oficial Express. No Express 5 do PromoBridge, montar `toNodeHandler(auth)` em `/api/auth/*splat` antes de `express.json()`. Usar `fromNodeHeaders(req.headers)` ao consultar a sessão no servidor. O cliente React é fornecido por `better-auth/react`. [Integração oficial](https://better-auth.com/docs/integrations/express).

Configuração principal proposta:

```ts
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
});
```

O código é ilustrativo: criar o cliente de forma lazy para o build não falhar antes de existirem env vars. Fixar a versão testada no lockfile. Aplicar o schema gerado/migrado e seu índice de email único; adicionar também a tabela de rate limit se for usada. [Instalação oficial](https://better-auth.com/docs/installation), [banco e schema](https://better-auth.com/docs/concepts/database).

O `BETTER_AUTH_SECRET` precisa ser estável entre deployments e ficar apenas no servidor. Produção usa a URL do domínio; previews precisam de configuração explícita de origem confiável, sem confiar em qualquer domínio arbitrário. Os segredos, hash de senha e tokens de sessão nunca são retornados no snapshot do painel. Cookies HttpOnly/Secure são geridos pela biblioteca.

Rate limit em memória não é compartilhado entre instâncias serverless. A documentação atual permite armazenamento no banco ou backend customizado com `consume` atômico; não implementar `get` seguido de `set` concorrentes. [Rate limit oficial](https://better-auth.com/docs/concepts/rate-limit).

## Blob privado é um fallback viável?

**Sim, para um produto de pequeno volume, com um adapter próprio cuidadosamente limitado e testado. Não é um banco transacional pronto nem uma substituição simples do driver `pg`.** Essa conclusão é uma inferência de engenharia a partir das garantias oficiais abaixo.

### Garantias existentes e verificadas

1. Store privado exige autenticação de leitura e escrita. Na Function, o SDK usa `BLOB_STORE_ID` + OIDC do deployment quando o store está conectado; também existe o token estático para código fora do Vercel. Usar `access: 'private'`. [Blob privado](https://vercel.com/docs/vercel-blob/private-storage).
2. `get(path, {access:'private', useCache:false})` lê a origem e garante o conteúdo mais recente. O padrão usa cache e pode ficar até 60 segundos desatualizado. Autenticação, revogação de sessão e decisões de unicidade exigem a leitura atual. [Leituras consistentes](https://vercel.com/docs/vercel-blob/private-storage#consistent-reads).
3. `get` retorna o ETag junto ao conteúdo. `put(..., {allowOverwrite:true, ifMatch:etag})` somente grava se o objeto não mudou; divergência gera `BlobPreconditionFailedError`. `copy` e `del` também aceitam condição. [Escritas condicionais](https://vercel.com/docs/vercel-blob#conditional-writes).

Esqueleto do armazenamento, sem criar um adapter completo:

```ts
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';

async function compareAndSwap<T>(
  pathname: string,
  mutate: (current: T) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await get(pathname, { access: 'private', useCache: false });
    if (!current || current.statusCode !== 200 || !current.stream) {
      throw new Error('Armazenamento não inicializado');
    }
    const oldValue = await new Response(current.stream).json() as T;
    const newValue = mutate(oldValue);
    try {
      await put(pathname, JSON.stringify(newValue), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        ifMatch: current.blob.etag,
      });
      return newValue;
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError)) throw error;
    }
  }
  throw new Error('Conflito de gravação; tente novamente');
}
```

Tratar criação inicial separadamente: um pathname fixo, `addRandomSuffix:false`, `allowOverwrite:false`; um concorrente que perde a criação recarrega o existente. Não tratar erro de leitura/rede como se fosse um banco vazio. O exemplo não cobre serialização segura de datas, schema, tamanho, unicidade ou transações.

### Desenho mínimo que pode preservar integridade

Manter **todos os registros de autenticação e os índices de unicidade em um mesmo objeto privado**: usuários, contas, sessões, verificações e counters. Cada alteração ocorre sobre um snapshot novo e só é aceita com CAS. Um cadastro deve reservar email e criar usuário+conta na mesma alteração; não escrever um arquivo de usuário e outro índice de email independentes.

Para transações Better Auth, o callback de DB opera num snapshot isolado em memória; publicar o snapshot com CAS somente ao final. Em conflito, executar novamente apenas as operações transacionais sem efeitos externos. Emails e webhooks ficam em hooks após commit. Toda consulta de segurança usa origem atual. Outra opção é `transaction:false`, admitida pela biblioteca, mas ela pode deixar gravações parciais quando passos posteriores falham; isso não é a escolha recomendada para cadastro robusto.

Dados do aplicativo podem ser separados em objetos por `userId`/workspace, desde que uma atualização de estado use CAS e a autorização sempre derive da sessão. Não incluir a fila de todos os usuários no blob central de autenticação. A separação reduz conflito, mas não oferece transação entre dois blobs. Provisionamento inicial dos dados pessoais pode ser idempotente e ocorrer depois da criação da conta.

### Custo e limites do fallback

- Cada decisão exige leitura da origem; cada alteração reescreve o objeto correspondente. O blob global de auth é um ponto de contenção, aumenta custo/latência com usuários e não é um desenho para escala geral.
- Fixar tamanho máximo e limite operacional documentado; expurgar registros expirados; não continuar em memória se o store falhar. Ao alcançar o limite, bloquear a operação com erro claro, sem perder silenciosamente dados.
- Um mutex de processo não protege instâncias Vercel distintas. O CAS é obrigatório em todas as gravações, inclusive revogação, limpeza, rate limit e reset.
- Não disponibilizar uma rota de download do blob global de auth. Um store privado protege acesso ao arquivo, mas cada rota do aplicativo ainda precisa checar sessão e propriedade.
- Preparar exportação/migração para Postgres. Não chamar o fallback de “Postgres”, “SQL” ou “banco transacional gerenciado”.

### Exigências do custom adapter

Better Auth admite `createAdapterFactory`. São necessárias operações de busca, criação, atualização, deleção, contagem e condição; `consumeOne` e `incrementOne` preservam consumo único e counters, com semântica atômica e número exato de linhas afetadas. Embora a versão atual tenha fallbacks, eles dependem das mesmas garantias. Usar transação real do snapshot ou declarar honestamente `transaction:false`. A biblioteca recomenda banco com transações. [Contrato oficial do adapter](https://better-auth.com/docs/guides/create-a-db-adapter).

Não implementar somente os métodos usados num único teste feliz de email/senha. Rodar `@better-auth/test-utils/adapter` e testes concorrentes de cadastro do mesmo email, logout, reset de uso único, falha no commit e duas gravações do mesmo estado. As mudanças de contrato da série 1.7 são documentadas; fixar versão. [Guia de atualização](https://better-auth.com/docs/guides/1-7-upgrade-guide).

## Escopo de persistência pessoal

No mínimo, cada conta precisa reabrir configurações de mensagem, regras/filtros, afiliações sem exposição de segredos, fontes/destinos, templates, estado de ofertas, histórico e preferências. O backend escolhe a chave do proprietário. Não aceitar `ownerId` do body como autorização nem retornar o estado completo de outra conta.

O worker local deve se vincular à conta por código temporário e credencial de dispositivo revogável, distinta de senha/cookie do usuário. A sessão WhatsApp continua no worker e não deve ser publicada no Blob ou no bundle. Configurações sincronizam entre a conta hospedada e o dispositivo autorizado; envio real precisa reportar o worker conectado.

## Critérios antes de anunciar como concluído

1. Cadastro e login reais, cookie de sessão e logout no domínio de produção.
2. Conta A configura o painel, fecha o navegador e reabre em outro aparelho: o servidor devolve as mesmas configurações.
3. Conta B não vê dados nem segredos da conta A; IDs alterados em requests não atravessam o limite.
4. Login e dados continuam após um novo deployment e após uma execução em outra instância serverless.
5. Gravações simultâneas preservam o estado ou devolvem conflito explícito; falha de backend não vira demonstração nem sucesso aparente.
6. Recuperação de senha por email só é anunciada após um provedor de envio efetivamente configurado e teste real. Sem email, oferecer alteração autenticada de senha e indicar claramente o estado de recuperação.

## Próximo passo concreto

**Preferido:** concluir a camada Better Auth + Postgres e fornecer o projeto pronto para conectar Neon; provisionar/ativar a integração quando houver acesso administrativo real. Se o objetivo for colocar contas remotas em funcionamento agora sem essa instalação, adotar Blob privado **somente** com adapter CAS de escopo pequeno, validação concorrente e documentação de limites. Em ambos os casos, a tela de login e o estado por usuário são reais e a demo fica em um caminho separado e explícito.
