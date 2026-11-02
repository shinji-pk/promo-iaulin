# Instruções do repositório

- Visual: siga **DESIGN.md** (identidade padrão Iaulin Bot). Cores, fontes, logo e mascote novos entram em `apps/web/src/brand.css` e `apps/web/src/Brand.tsx`; não crie paletas paralelas nem volte à fonte serifada.
- Leveza: sem bibliotecas de UI/animação; SVG inline e CSS puro.
- Responder em português.

## Regras permanentes da Shinji Apps (definidas pela dona em 02/11/2026)
- **Logo, cores e identidade visual são fixas.** "Melhorar design / qualidade / 4K" significa nitidez (SVG, imagens em alta densidade), tipografia, alinhamento e acabamento. Nunca trocar a logo, a paleta ou o estilo do app sem pedido explícito da dona.
- **Nada de conta ou dado de mentira:** sem login "de mentira" quando o servidor falha, sem sessão só no navegador fingindo conta, sem usuários, agendas, rankings ou números inventados aparecendo como reais.
- **Infra:** apps Shinji = Neon (banco e contas Shinji ID) + Cloudflare/GitHub. **GTF Hub = Supabase próprio da Georgia Top Floors** e não tem nenhuma relação com a Shinji Apps (nem no site, nem em domínio, nem em créditos).
- Emet, Finance PK e Promo IAulin são apps independentes (nenhum é módulo do outro).
- Perfil proporcional ao app: apps simples (Bíblia, Alexia) pedem só o básico; apps complexos (Órbita, Emet) pedem mais aos poucos, com campos opcionais marcados como opcionais.
- Antes de dizer que algo está no ar, conferir o endereço público real (hoje os domínios *.shinjiapps.com são servidos pela Vercel).

## Servidor na Cloudflare + Neon (02/11/2026)
- O servidor da conta e dos dados (`apps/cloud`, Express) roda na Cloudflare Pages por `functions/api/[[path]].ts` (`cloudflare:node` + `nodejs_compat`). Na Vercel continua `api/index.js` com o Blob.
- Armazenamento: `apps/cloud/src/blob-store.ts` usa o **Neon** (tabela `promo_docs`, projeto shinji-promo-iaulin, banco `promo`) quando há `DATABASE_URL` e não há Blob; na Vercel continua o Blob.
- O WhatsApp (Baileys) precisa de servidor sempre ligado: fica no servidor próprio (Docker/Render, `MANAGED_WORKER_URL`), não na Cloudflare.
- Para manter válidas as perguntas de recuperação já cadastradas, a Cloudflare precisa da mesma `BETTER_AUTH_SECRET` da Vercel (segredo `PROMO_BETTER_AUTH_SECRET` no GitHub). Sem ele, é usada uma chave derivada do banco.
- **Só mudar o DNS do Promo para a Cloudflare depois de rodar "Copiar contas do Promo para o Neon"** (precisa do segredo `BLOB_READ_WRITE_TOKEN`) e trocar `BETTER_AUTH_URL` no `wrangler.toml` para o endereço final.
