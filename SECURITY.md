# Segurança

Senhas de marketplace, códigos SMS/2FA, cookies e sessões não devem ser enviados pelo chat. Credenciais específicas de APIs de afiliados são cadastradas apenas no painel local; ficam em cofre AES-256-GCM, com chave local protegida e fora do Git e do backup. Arquivos da sessão WhatsApp equivalem a acesso à conta e exigem proteção no computador.

A conta online usa Better Auth, hashes de senha da biblioteca e cookies de sessão HttpOnly/Secure. Alterações exigem origem autorizada e token CSRF. Cadastro e login têm limites de tentativas. A troca de senha revoga sessões antigas e entrega um novo cookie. Recuperação e verificação por e-mail aguardam configuração de provedor.

O armazenamento Vercel Blob é privado; o token de acesso permanece no servidor. Cada usuário acessa somente seu próprio documento. Operações concorrentes usam ETag/CAS. O adapter de autenticação aplica transações, unicidade e referências. A solução tem limites de tamanho para pequeno volume; falhas de persistência não resultam em uma sessão fictícia.

O worker escuta somente em loopback e verifica Host, origem e CSRF. Não faça port forwarding direto. O acesso remoto opcional usa túnel, código de pareamento de uso único e sessões revogáveis. Cabeçalhos de proxy impedem que uma conexão encaminhada seja confundida com administração local. Credenciais e controle de túnel permanecem restritos ao computador.

O proxy online fixa DNS público no transporte TLS, bloqueia redes privadas, não encaminha cookies em redirecionamentos e aceita apenas JSON ou JPEG limitado. O cookie do computador é criptografado com vínculo à conta. A resolução de links também valida DNS e cada salto. URLs afiliadas de saída não são visitadas automaticamente.

Reservas persistentes impedem envios concorrentes; confirmações ambíguas exigem conferência humana e não são repetidas automaticamente. Restaurar backup não restaura provas de afiliação ou aprovações e preserva evidência de envios posteriores.

Baileys é uma integração não oficial e pode sofrer restrições pelo WhatsApp. Use número e grupos autorizados e confira uma publicação real e sua atribuição no programa antes de operar continuamente. A existência de uma tag não comprova comissão ou titularidade.
