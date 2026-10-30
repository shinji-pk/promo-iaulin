import { describe, expect, it } from 'vitest';
import { parseOffer } from '../packages/core/src/parser.ts';

describe('descontos percentuais com elegibilidade não verificada', () => {
  it.each([
    'Perfume\n50% OFF apenas no app',
    'Perfume\n50% de desconto para novos clientes',
    'Perfume\n50% OFF na segunda unidade',
    'Perfume\n50% OFF com cupom PERFUME10',
    'Perfume\nCom cupom PERFUME10: 50% OFF',
    'Perfume\n50% OFF no cartão da loja',
    'Perfume\n50% OFF a partir de R$ 200',
    'Perfume\n50% OFF sujeito a condições',
  ])('não transforma benefício condicionado em desconto irrestrito: %s', text => {
    expect(parseOffer(text).discount).toBeNull();
  });

  it.each([
    ['Perfume\n50% OFF', 50],
    ['Perfume\n50% OFF para todos', 50],
    ['Perfume\n50% OFF\nFrete grátis', 50],
    ['Perfume\nDe R$ 200 por R$ 100', 50],
  ])('mantém desconto sem restrição: %s', (text, discount) => {
    expect(parseOffer(text).discount).toBe(discount);
  });
});
