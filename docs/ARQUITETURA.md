# Arquitetura e decisões

O PromoBridge 2 separa a interface do processo persistente. A V1 original permanece no handoff como referência; esta implementação tem contratos próprios.

| Pasta | Responsabilidade |
| --- | --- |
| apps/web | React, Vite, painel em português, onboarding e demonstração local ao navegador |
| apps/worker | API no computador, conexão WhatsApp e execução da fila |
| packages/shared | Contratos TypeScript e schemas Zod |
| packages/core | Extração, resolução, decisões e reescrita |
| packages/affiliate-adapters | Reconhecimento e validação por marketplace |
| packages/scoring | Curadoria explicável e influência conservadora do feedback |
| packages/db | SQLite, migrations, configuração e histórico |

Node.js 24 LTS foi escolhido pelo suporte a SQLite integrado, eliminando a compilação de um driver nativo no Windows. O monorepo tem um lockfile e um conjunto de dependências fixadas. TypeScript strict é verificado antes do build. Vite gera arquivos estáticos servidos pelo próprio worker ou pelo Vercel.

O worker escuta apenas em 127.0.0.1. A interface e a API usam a mesma origem, verificação de Host/Origin e token contra requisições cruzadas. Isso não oferece controle remoto: exposição pública exige autenticação e um canal seguro adicionais. A demonstração hospedada não se conecta ao PC e não contém sessão, banco ou QR reais.

As ofertas são persistidas antes de qualquer envio. Reservas e estados impedem repetição concorrente; uma confirmação ambígua requer intervenção, em vez de reenvio automático. A simulação não envia mensagens. Afiliação e regras são verificadas novamente na publicação, incluindo alterações na configuração e na mensagem.

Os adaptadores não deduzem regras de comissão a partir de parâmetros arbitrários. A Amazon admite validação de ASIN e tag pública por um par de links do mesmo produto. As demais lojas têm reconhecimento e canonicalização; geração oficial de afiliação permanece bloqueada até uma implementação específica e validação real. Calibração estrutural não prova titularidade da conta nem pagamento de comissão.

O score é determinístico e mostra os fatores usados. Feedback modifica a preferência de forma limitada; não há modelo treinado ou alegação de machine learning sem dados. Preços e cupons são extraídos da mensagem; não são preço de mercado verificado, disponibilidade ou reputação de vendedor.

Limites: não há sincronização entre vários computadores, controle remoto, envio de mídia pesada, consulta oficial de comissão, garantia de entrega exatamente uma vez pelo WhatsApp ou integração oficial de geração para seis marketplaces. Esses itens exigem evolução e validação próprias.
