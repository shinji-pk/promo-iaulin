# Segurança

Não envie senhas, códigos SMS/2FA, cookies, exportações da sessão ou tokens pelo chat. O painel pede somente identificadores públicos e links de calibração. A sessão vinculada do WhatsApp fica em armazenamento local ignorado pelo Git; os arquivos de sessão equivalem a acesso à conta e precisam de proteção no computador.

O uso de Baileys é uma integração não oficial. Pode causar restrição ou bloqueio pelo WhatsApp; use um número separado e grupos que autorizaram o monitoramento. Limites de envio reduzem excesso, mas não eliminam esse risco.

O worker é local e escuta somente em loopback. Não faça port forwarding nem o publique diretamente. O painel hospedado é uma demonstração isolada. A API valida Host/Origin e exige token CSRF em alterações.

O resolvedor verifica destinos públicos em cada salto, fixa a resolução DNS no transporte e limita tempo, tamanho e redirecionamentos. Falha de DNS, produto não reconhecido, afiliação desconhecida ou link suspeito bloqueiam o envio.

Backups do painel contêm configuração pública, ofertas e atividade; não incluem sessão WhatsApp. Ainda podem conter nomes de grupos e textos recebidos: guarde-os em local privado. Segredos, bancos, sessão e dados operacionais são ignorados pelo Git.

Antes de uso contínuo, valide um envio real com um produto conhecido e confirme sua atribuição no programa de parceiros. A presença de uma tag não comprova titularidade, elegibilidade ou comissão paga.
