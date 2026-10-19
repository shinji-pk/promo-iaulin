# Arquitetura 2.1

O Iaulin Bot mantém a interface React/Vite, o processo persistente do WhatsApp e a conta online em camadas separadas.

| Camada | Função e persistência |
| --- | --- |
| `apps/web` | Painel legível em português, guia flutuante, login e configuração contextual |
| `apps/cloud` + `api/index.js` | Better Auth, sessões, isolamento por usuário, preferências e última sincronização em Vercel Blob privado |
| `apps/worker` | Processo local Node 24, WhatsApp, grupos, fila, agendamento, mídia limitada e APIs oficiais |
| `packages/db` | SQLite local, migrations, histórico, reservas persistentes e recuperação de envios incertos |
| `packages/core` | Parsing, orçamento total de 20 segundos, score, revisão, deduplicação e regras de publicação |
| `packages/affiliate-adapters` | Identidades por marketplace e clientes Amazon Creators API, Shopee e AliExpress |

## Conta e dados

Better Auth gerencia senhas e cookies, cadastro, login, logout e troca de senha. O backend é compilado para JavaScript antes do empacotamento da Function. Leituras privadas usam representação sem compressão, preservando o ETag forte para alterações condicionais. O servidor identifica o usuário pela sessão; IDs enviados pelo cliente não selecionam outro espaço. Os documentos privados usam ETag e gravação condicional para evitar perda de alterações entre instâncias. O adapter autentica e modifica todas as tabelas da autenticação em um documento transacional, com unicidade, referências e rollback. As senhas são hashes produzidos pela biblioteca.

Essa implementação atende uma instalação de pequeno volume: o documento global de autenticação tem limite de 8 MiB e cada espaço também tem limite de 8 MiB. A cópia online mantém até 3.000 ofertas e 300 atividades; o painel mostra até 1.000 ofertas. O worker conserva o histórico completo conforme a retenção. Para crescimento significativo, migrar autenticação e consultas para Postgres, preservando IDs e contratos. Não há recuperação/verificação por e-mail sem um provedor configurado.

Sem computador conectado, a conta salva preferências e simulações e exibe a última cópia sincronizada sem alegar conexão WhatsApp. Não tenta executar envios em Vercel Functions. O backup offline reflete a cópia online; o backup completo deve ser feito com o computador conectado.

## Canal para o computador

O worker continua escutando em loopback. Acesso remoto é opcional e iniciado apenas no computador. Cloudflared é obtido da distribuição oficial, com SHA-256 conferido. O túnel temporário serve para testes e não promete endereço ou disponibilidade estáveis; o modo gerenciado depende do domínio e da conta Cloudflare da titular.

Pareamento: código aleatório de uso único, cinco minutos, enviado no fragmento do link; sessão de dispositivo por oito horas, cookie HttpOnly/Secure/SameSite Strict, token armazenado somente como hash local. O site guarda seu cookie de conexão criptografado e vinculado ao usuário. Reiniciar ou revogar encerra os pareamentos. O proxy confere e fixa DNS público em cada conexão TLS, não segue redirecionamentos e limita respostas. Administração do túnel e entrada de credenciais são exclusivas do computador.

## Afiliação e publicação

URLs diretas reconhecidas são canonicalizadas sem visita externa. Apenas links originais desconhecidos podem ser expandidos com DNS/IP públicos, redirecionamentos conferidos e prazo limitado. URLs afiliadas de saída não são abertas para criar cliques artificiais.

As APIs geram recibos assinados que vinculam produto, URL, configuração e revisão de credenciais. Mudanças ou expiração invalidam a autorização. Links importados da biblioteca têm confiança de revisão humana por produto e nunca entram na publicação automática; uma decisão manual ou um agendamento explícito continua necessário.

Publicação confere novamente identidade, afiliação, texto, grupo, permissão, score, confiança, repetição, validade, pausa e frequência. A preflight ocorre antes da reserva persistente. Falhas de transporte ambíguas ficam incertas, sem tentativa automática repetida. A titular confere o grupo e reconcilia o resultado pela interface.

O aplicativo não confirma pagamento de comissão, estoque, menor preço de mercado, reputação ou validade de cupom. A integração Baileys não é oficial e depende de validação real com o número da titular.
