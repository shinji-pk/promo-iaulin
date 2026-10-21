# Promo · Iaulin Bot · padrão visual (obrigatório)

Identidade padrão do app. Toda tela nova ou alterada segue estas regras. Guia visual completo (Finance, GTF e Emet também): artefato "Identidade dos 3 apps".

## Arquivos
- `apps/web/src/brand.css` — tokens e acabamento da marca, importado por último em `main.tsx`. O logo (etiqueta com seta) é aplicado em todo `.brand-mark` por CSS.
- `apps/web/src/Brand.tsx` — `LogoMark` e o mascote `Iaulin` (expressões `happy`, `think`, `party`, `alert`).
- `apps/web/src/HelpMascot.tsx` — ajuda no login e bolha de boas-vindas; `FloatingGuide.tsx` usa o mesmo mascote.
- `apps/web/src/polish.css` + `ripple.ts` — toque nos botões, foco visível, foto de perfil.

## Cores
| Token | Hex | Uso |
| --- | --- | --- |
| `--night` | #1A0A1D | barra lateral, tela de entrada, destaques |
| `--plum-brand` | #3B1838 | texto de marca, ameixa |
| `--flash` | #FF4F7B | ação (gradiente até `--offer` #FF7A45) |
| `--coupon` | #FFD25A | só preço, cupom e contadores |
| `--blush` | #FFF8FB | fundo claro do conteúdo |

## Tipografia
- Títulos e preços: **Unbounded** 600–700. Texto: **DM Sans** 400–700. Só esses pesos no Google Fonts.

## Formas e movimento
- Cartões 18–26 px, botões 14 px, etiquetas com recorte. Nada quadrado.
- Efeito de toque e `scale(.965)`; respeitar `prefers-reduced-motion`.
- Mascote Iaulin: estados vazios (`think`), ajuda/login (`happy`), oferta boa (`party`), alerta (`alert`).

## Leveza
- Sem bibliotecas de UI/animação; SVG inline e CSS puro. O Promo vai virar módulo do Emet: manter os tokens isolados aqui facilita a migração.
