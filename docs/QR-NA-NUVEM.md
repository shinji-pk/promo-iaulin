# Conectar o WhatsApp só com o QR Code (sem baixar nada)

Para o QR Code aparecer direto no site, o WhatsApp precisa de um **servidor sempre ligado**.
A Vercel não consegue fazer isso sozinha, então você ativa um servidor pequeno **uma única vez**.
Depois disso, ninguém precisa instalar nada: é só abrir o site, clicar em **Conectar WhatsApp** e escanear.

## Passo 1: ligar o servidor (2 minutos)

1. Abra: <https://render.com/deploy?repo=https://github.com/shinji-pk/promo-iaulin>
2. Entre com sua conta GitHub e clique em **Apply** / **Deploy Blueprint**.
3. O plano usado é o **Starter** (pago, na ordem de US$ 7 por mês, confira o valor atual no Render).
   Ele é necessário porque o plano gratuito "dorme" e derrubaria o WhatsApp.
4. Espere ficar **Live** (uns 5 a 10 minutos na primeira vez).

Anote duas coisas do serviço **promo-iaulin-whatsapp**:

- o **endereço** (aparece no topo, algo como `https://promo-iaulin-whatsapp.onrender.com`);
- a **senha do servidor**: aba **Environment** → `PROMOBRIDGE_CLOUD_TOKEN` → botão de copiar.

## Passo 2: avisar o site (2 minutos)

Na Vercel, abra o projeto do site em **Settings → Environment Variables** e crie três variáveis (marque Production):

| Nome | Valor |
| --- | --- |
| `MANAGED_WORKER_URL` | o endereço do passo 1, sem barra no final e sem porta |
| `MANAGED_WORKER_TOKEN` | a senha copiada no passo 1 |
| `MANAGED_WORKER_OWNERS` | o e-mail com que você entra no site (vários: separe por vírgula) |

Depois vá em **Deployments → ⋯ → Redeploy**.

## Passo 3: conectar

1. Entre no site e abra **Fontes & conexões**.
2. Clique em **Conectar WhatsApp**. O QR Code aparece na tela.
3. No celular: WhatsApp → **Dispositivos conectados** → **Conectar dispositivo** → escaneie.

Pronto. Pode fechar o site e desligar o computador. A sessão fica salva no disco do servidor
e volta sozinha se ele reiniciar.

## Se algo não funcionar

- **O site continua pedindo para ativar o servidor:** confira se as três variáveis existem na Vercel, se o
  e-mail é o mesmo do login e se fez o Redeploy.
- **"Servidor não respondeu":** no Render, o serviço precisa estar **Live**. Abra `ENDEREÇO/healthz`; deve mostrar `{"ok":true}`.
- **Pediu QR Code de novo:** o disco `whatsapp-data` precisa existir (já vem no `render.yaml`).

## Outras hospedagens

O arquivo `Dockerfile` funciona em qualquer lugar que rode Docker (Railway, Fly.io, VPS).
Requisitos: variável `PROMOBRIDGE_CLOUD_TOKEN` com 32+ caracteres, um disco persistente montado em `/app/data`
e o endereço público em HTTPS.

## Alternativa: usar o computador

O instalador para Windows continua existindo, mas é opcional e não é o caminho recomendado.
