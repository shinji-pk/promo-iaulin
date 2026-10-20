# Recuperação de senha por e-mail — preparação antes de registrar o domínio

## Estado em 20/10/2026

- O aplicativo já implementa o fluxo **Esqueci minha senha**, solicitação de link, token de uso único com validade de 30 minutos, alteração de senha e invalidação das sessões após redefinição.
- Better Auth, seu segredo e armazenamento de contas já têm variáveis próprias na Vercel. **Nunca substitua** BETTER_AUTH_SECRET ou dados do Blob para configurar e-mail, pois isso pode invalidar sessões e comprometer contas existentes.
- `RESEND_API_KEY` está configurada como segredo criptografado na Vercel em `promo-iaulin-mkce` (principal, domínio `iaulinbot.vercel.app`) e `promo-iaulin` (implantação adicional).
- **Ainda não há remetente liberado nem teste de entrega aprovado**. A interface mantém envio/alteração de e-mail indisponíveis enquanto faltar remetente. A presença da API key não prova posse do domínio.
- O endereço do aplicativo e o domínio do e-mail são **independentes**. Pode-se continuar usando `iaulinbot.vercel.app` enquanto se envia de um domínio próprio comum a outros aplicativos.

## Única variável de remetente a preencher DEPOIS de verificar DNS no Resend

Na Vercel, para cada projeto Promo ativo, em **Settings → Environment Variables**:

```dotenv
TRANSACTIONAL_EMAIL_DOMAIN=SEU-DOMINIO-VERIFICADO.COM
```

- Alvos: Production e Preview (cada um precisa de chave `RESEND_API_KEY`, já presente).
- Valor: somente nome do domínio registrado e marcado **Verified** no Resend, sem `https://`, caminhos ou prefixos.
- Remetente gerado automaticamente: `Promo IAulin <promo@SEU-DOMINIO-VERIFICADO.COM>`.
- Opcional: `RESEND_FROM_EMAIL` substitui o remetente automático, se você precisar de um endereço personalizado. Não configure ambos sem necessidade.
- Não use `.vercel.app` como domínio remetente.
- Após salvar variáveis, crie **novo deploy de produção**: deploys antigos não adquirem automaticamente novas variáveis.
- Teste cadastro de uma conta de teste, solicitação de recuperação, recebimento na caixa e no spam, prazo e uso único do link, criação de nova senha, invalidação da senha anterior e login com a nova. Consulte Logs do Resend para distinguir e-mail aceito de e-mail entregue.

## Segurança e operação

- Nunca colocar `RESEND_API_KEY` no GitHub ou no front-end. O envio é executado no servidor.
- A chave já foi colada numa conversa: **revogá-la/rotacioná-la** na conta Resend e substituir o segredo `RESEND_API_KEY` nos projetos afetados antes do uso real.
- Use um domínio central neutro, mas mantenha remetentes diferentes por aplicativo.
- Verifique DKIM e SPF do domínio no painel de DNS do registrador; adicionar o domínio ao painel Resend não o compra.
- Se o domínio não estiver verificado, **não** configure `TRANSACTIONAL_EMAIL_DOMAIN`. Assim não há promessa de envio inexistente.
- Testar provedores em produção exige caixa de teste autorizada. Não envie links para endereços de usuários reais como teste.
