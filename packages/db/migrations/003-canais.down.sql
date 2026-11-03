-- Reversão da migração 3 (Canais do WhatsApp).
-- ATENÇÃO: apaga canais, publicações, fontes e notícias. Faça backup do arquivo
-- data/promobridge.sqlite (com o aplicativo fechado) antes de executar.
-- Ofertas, grupos, configurações e a sessão do WhatsApp não são afetados.
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS channel_events;
DROP TABLE IF EXISTS news_items;
DROP TABLE IF EXISTS news_sources;
DROP TABLE IF EXISTS channel_posts;
DROP TABLE IF EXISTS channels;
DELETE FROM records WHERE namespace IN ('channel-config','channel-templates','channel-media','channel-ai','channel-ai-usage');
PRAGMA user_version=2;
COMMIT;
