/**
 * Motor de Inteligência e Compreensão em Linguagem Natural para Mascotes.
 * 
 * Funcionalidades:
 * 1. 100% Gratuito e offline por padrão: roda no navegador sem custos de API ou limites.
 * 2. Tolerância a erros de digitação (Damerau-Levenshtein / Fuzzy matching).
 * 3. Normalização linguística em português (remoção de acentos, pontuação, gírias e sinônimos).
 * 4. Detecção de intenções e respostas contextuais com botões de ação do app.
 * 5. Integração opcional com Google Gemini Flash (camada gratuita do Google AI Studio).
 */

export interface MascotTopic {
  id: string;
  title: string;
  text: string;
  keywords: string[];
  synonyms?: string[];
  action?: [string, string]; // [label, actionKey]
}

export interface MascotAnswer {
  matchedTopic: MascotTopic | null;
  reply: string;
  confidence: number;
  suggestions: MascotTopic[];
  isAI: boolean;
}

// Normaliza texto: remove acentos, pontuação, múltiplos espaços e põe em minúsculas
export function normalizeText(s: string): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dicionário de atalhos e gírias comuns em português
const SYNONYMS: Record<string, string[]> = {
  senha: ['senah', 'pass', 'password', 'acesso', 'chave', 'codigo', 'cod', 'pin'],
  esqueci: ['esqeci', 'perdi', 'sumiu', 'recuperar', 'recadastrar', 'redefinir', 'resetar', 'nao sei'],
  conta: ['cadrasto', 'cadastro', 'login', 'perfil', 'usuario', 'entrar', 'registro'],
  whatsapp: ['zap', 'watsap', 'wpp', 'whats', 'whatapp', 'mensagens'],
  foto: ['avatar', 'imagem', 'foto de perfil', 'icone'],
  seguranca: ['seguro', 'privacidade', 'privado', 'proteger', 'dados', 'vazamento'],
  celular: ['telefone', 'fone', 'tel', 'aparelho', 'numero'],
  computador: ['pc', 'notebook', 'mac', 'windows', 'desktop'],
  link: ['afiliado', 'url', 'loja', 'amazon', 'shopee', 'aliexpress', 'comissao'],
  oferta: ['promocao', 'desconto', 'cupom', 'preco', 'barato'],
  grupo: ['grupos', 'canal', 'destinatario', 'vendas', 'fontes'],
};

// Calcula a distância Levenshtein entre duas palavras
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

// Similaridade entre duas palavras de 0.0 a 1.0
export function wordSimilarity(w1: string, w2: string): number {
  if (w1 === w2) return 1.0;
  if (w1.length === 0 || w2.length === 0) return 0.0;
  // Substring direta
  if (w1.length >= 3 && (w2.includes(w1) || w1.includes(w2))) {
    return 0.88;
  }
  const dist = levenshtein(w1, w2);
  const maxLen = Math.max(w1.length, w2.length);
  return Math.max(0, 1 - dist / maxLen);
}

// Verifica se uma palavra do usuário combina com uma palavra-chave (exata, sinônimo ou com erro de digitação)
function matchWord(userWord: string, targetWord: string): number {
  if (userWord === targetWord) return 1.0;
  
  // Confere se é sinônimo conhecido
  for (const [key, list] of Object.entries(SYNONYMS)) {
    if ((key === targetWord || list.includes(targetWord)) && (key === userWord || list.includes(userWord))) {
      return 0.95;
    }
  }

  // Tolerância a erros de digitação (Levenshtein)
  const sim = wordSimilarity(userWord, targetWord);
  if (sim >= 0.72) return sim;

  return 0;
}

// Pontua um tópico para uma dada consulta do usuário
export function scoreTopic(query: string, topic: MascotTopic): number {
  const normQuery = normalizeText(query);
  if (!normQuery) return 0;

  const queryWords = normQuery.split(' ').filter(w => w.length >= 2);
  if (queryWords.length === 0) return 0;

  const normTitle = normalizeText(topic.title);
  const normText = normalizeText(topic.text);

  let score = 0;

  // Frase exata no título ou sinônimos
  if (normTitle.includes(normQuery)) {
    score += 120;
  }
  if (topic.synonyms) {
    for (const syn of topic.synonyms) {
      const normSyn = normalizeText(syn);
      if (normSyn === normQuery) score += 150;
      else if (normSyn.includes(normQuery) || normQuery.includes(normSyn)) score += 90;
    }
  }

  // Compara cada palavra da busca com as palavras-chave do tópico
  for (const qWord of queryWords) {
    let wordBest = 0;

    // No título
    for (const tWord of normTitle.split(' ')) {
      const s = matchWord(qWord, tWord);
      if (s > wordBest) wordBest = s * 40;
    }

    // Nas palavras-chave
    for (const kw of topic.keywords) {
      const normKw = normalizeText(kw);
      for (const kWord of normKw.split(' ')) {
        const s = matchWord(qWord, kWord);
        if (s * 35 > wordBest) wordBest = s * 35;
      }
    }

    // No corpo do texto
    if (wordBest < 15) {
      for (const bWord of normText.split(' ')) {
        const s = matchWord(qWord, bWord);
        if (s * 15 > wordBest) wordBest = s * 15;
      }
    }

    score += wordBest;
  }

  return score;
}

// Responde à dúvida do usuário com inteligência local
export function queryMascotBrain(query: string, topics: MascotTopic[], mascotName = 'Iaulin'): MascotAnswer {
  const raw = query.trim();
  const normalized = normalizeText(raw);

  // Saudações comuns
  if (/^(oi|ola|bom dia|boa tarde|boa noite|ola iaulin|oi iaulin|e ai|oie|opa)\b/i.test(normalized)) {
    return {
      matchedTopic: null,
      reply: `Oi! Eu sou o ${mascotName} ✨ Estou aqui para te ajudar com tudo no aplicativo. Pode me fazer qualquer pergunta, como recuperar senha, conectar o WhatsApp ou mudar suas informações!`,
      confidence: 1.0,
      suggestions: topics.slice(0, 3),
      isAI: true,
    };
  }

  // Agradecimentos
  if (/^(obrigado|valeu|muito obrigado|valeu mesmo|agradecido|obg|brigado|show|perfeito|entendi)\b/i.test(normalized)) {
    return {
      matchedTopic: null,
      reply: `Por nada! Qualquer outra dúvida que tiver sobre o aplicativo, pode me chamar a qualquer momento! 😊`,
      confidence: 1.0,
      suggestions: [],
      isAI: true,
    };
  }

  // Pontuação de todos os tópicos
  const scored = topics
    .map(t => ({ topic: t, score: scoreTopic(normalized, t) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best && best.score >= 30) {
    const isHigh = best.score >= 60;
    const suggestions = scored.slice(1, 4).filter(s => s.score >= 15).map(s => s.topic);

    return {
      matchedTopic: best.topic,
      reply: isHigh
        ? best.topic.text
        : `Acredito que sua dúvida seja sobre "${best.topic.title}":\n\n${best.topic.text}`,
      confidence: Math.min(1.0, best.score / 100),
      suggestions,
      isAI: true,
    };
  }

  // Nenhuma correspondência forte: sugestão amigável
  return {
    matchedTopic: null,
    reply: `Não entendi com certeza o que você quis dizer por "${raw}". Veja se algum destes assuntos pode te ajudar:`,
    confidence: 0,
    suggestions: topics.slice(0, 4),
    isAI: false,
  };
}

/**
 * Consulta ao Google Gemini 1.5/2.0 Flash (camada gratuita do Google AI Studio).
 * Se o usuário cadastrar uma chave gratuita de IA, ela complementa as respostas locais.
 */
export async function queryGeminiFlash(
  apiKey: string,
  query: string,
  appContext: string,
  mascotName = 'Iaulin'
): Promise<string | null> {
  if (!apiKey || !apiKey.trim()) return null;

  const prompt = `Você é o ${mascotName}, um mascote prestativo, bem-humorado, paciente e inteligente de inteligência artificial dentro do aplicativo.
O usuário enviou uma pergunta no app. Mesmo se ele digitar com erros de ortografia, palavras comidas, gírias ou abreviações (como "zap", "commo", "senah"), compreenda o que ele quer dizer e responda com clareza em português do Brasil.

INFORMAÇÕES E CONTEXTO DO APLICATIVO:
${appContext}

REGRAS:
1. Seja amigável, acolhedor e direto.
2. Não invente recursos que o aplicativo não possui.
3. Se a dúvida tiver relação com alguma etapa ou botão do app, explique onde clicar.
4. Mantenha a resposta com menos de 3 parágrafos curtos.

DÚVIDA DO USUÁRIO: "${query}"`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey.trim()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}
