import { describe, expect, it } from 'vitest';
import { levenshtein, normalizeText, queryMascotBrain, MascotTopic } from '../apps/web/src/mascotBrain.ts';

const SAMPLE_TOPICS: MascotTopic[] = [
  {
    id: 'recover',
    title: 'Esqueci minha senha',
    text: 'Toque em Esqueci minha senha. Você recupera com o código .txt ou respondendo às suas perguntas.',
    keywords: ['senha', 'recuperar', 'esqueci', 'perdi', 'redefinir', 'codigo txt'],
    synonyms: ['não consigo entrar', 'perdi meu acesso', 'como recuperar login', 'esqueci o login'],
    action: ['Recuperar minha senha', 'recover'],
  },
  {
    id: 'signup',
    title: 'Ainda não tenho conta',
    text: 'Use Criar conta: nome, e-mail, senha e perguntas.',
    keywords: ['criar conta', 'cadastro', 'registro', 'novo usuario'],
    synonyms: ['quero me cadastrar', 'como criar conta'],
    action: ['Criar minha conta', 'signup'],
  },
  {
    id: 'profile',
    title: 'Onde mudo meu nome, foto ou telefone?',
    text: 'Toque no seu avatar no canto superior direito para editar nome, telefone e foto.',
    keywords: ['foto', 'avatar', 'nome', 'telefone', 'perfil', 'editar'],
    synonyms: ['como mudar foto', 'trocar imagem', 'alterar telefone'],
  },
  {
    id: 'security',
    title: 'Meus dados ficam seguros?',
    text: 'Cada conta tem seus dados separados no servidor. Nunca pedimos senha nem código.',
    keywords: ['seguranca', 'privacidade', 'dados', 'seguro', 'protegido'],
  },
];

describe('MascotBrain NLP and Fuzzy Intelligence', () => {
  it('normalizes accents, casing and special characters', () => {
    expect(normalizeText('Olá! Como vai você?')).toBe('ola como vai voce');
    expect(normalizeText('São Paulo - BR')).toBe('sao paulo br');
  });

  it('computes Levenshtein distance correctly', () => {
    expect(levenshtein('senha', 'senah')).toBe(2);
    expect(levenshtein('esqueci', 'esqeci')).toBe(1);
    expect(levenshtein('whatsapp', 'watsap')).toBe(2);
  });

  it('understands severe typos in questions', () => {
    // "esqeci minah senah" (typos on both words)
    const result1 = queryMascotBrain('esqeci minah senah', SAMPLE_TOPICS);
    expect(result1.matchedTopic?.id).toBe('recover');

    // "commo mudo foto" (doubled letter and colloquial phrase)
    const result2 = queryMascotBrain('commo mudo foto', SAMPLE_TOPICS);
    expect(result2.matchedTopic?.id).toBe('profile');

    // "meus dado tao seguro"
    const result3 = queryMascotBrain('meus dado tao seguro', SAMPLE_TOPICS);
    expect(result3.matchedTopic?.id).toBe('security');
  });

  it('understands different phrases for the same intention', () => {
    // "perdi meu acesso" -> recover
    const result1 = queryMascotBrain('perdi meu acesso', SAMPLE_TOPICS);
    expect(result1.matchedTopic?.id).toBe('recover');

    // "quero me cadastrar" -> signup
    const result2 = queryMascotBrain('quero me cadastrar', SAMPLE_TOPICS);
    expect(result2.matchedTopic?.id).toBe('signup');

    // "trocar imagem do perfil" -> profile
    const result3 = queryMascotBrain('trocar imagem do perfil', SAMPLE_TOPICS);
    expect(result3.matchedTopic?.id).toBe('profile');
  });

  it('responds politely to greetings and thanks', () => {
    const greeting = queryMascotBrain('Oi Iaulin!', SAMPLE_TOPICS);
    expect(greeting.reply).toContain('Eu sou o Iaulin');

    const thanks = queryMascotBrain('obrigado!', SAMPLE_TOPICS);
    expect(thanks.reply).toContain('Por nada');
  });
});
