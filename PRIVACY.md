# Privacidade — PromoBridge V1

## Onde os dados ficam

Na execução local, configurações, sessão vinculada do WhatsApp, fila/histórico e banco SQLite ficam na pasta `data/` do próprio computador.

## O que o projeto processa

O bot processa apenas mensagens recebidas nos grupos de origem que o usuário selecionou. O conteúdo necessário para a automação pode ser gravado localmente no histórico para diagnóstico, fila e prevenção de repetição.

## O que não deve ser publicado

A pasta `data/` é ignorada pelo Git. Ela pode conter sessão do WhatsApp e histórico local. Nunca a envie manualmente para GitHub, Vercel ou terceiros.

## Serviços externos

Os links de produtos são acessados pela internet para resolver redirecionamentos. O WhatsApp é acessado por uma biblioteca não oficial que opera como cliente Web vinculado. Esta V1 não envia as mensagens para uma API de IA paga.
