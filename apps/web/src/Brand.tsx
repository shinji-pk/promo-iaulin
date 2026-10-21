import { useId } from 'react';

/**
 * Identidade "Iaulin Bot" — padrão do app (ver DESIGN.md).
 * Logo: etiqueta de preço com seta para cima (a oferta subindo no grupo).
 * Mascote: Iaulin, etiqueta-robô com antena de faísca, 4 expressões. SVG inline, poucos KB.
 */
export type Mood = 'happy' | 'think' | 'party' | 'alert';
const useUid = () => useId().replace(/[^a-zA-Z0-9]/g, '');

export function LogoMark({ size = 34 }: { size?: number }) {
  const id = 'ibLogo' + useUid();
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff4f7b" /><stop offset="1" stopColor="#7a1f6e" /></linearGradient></defs>
    <rect width="64" height="64" rx="18" fill={`url(#${id})`} />
    <path d="M12 22c0-4 3-7 7-7h19l14 14v18c0 4-3 7-7 7H19c-4 0-7-3-7-7z" fill="#fff" />
    <circle cx="43" cy="24" r="3.2" fill="#ff4f7b" />
    <path d="M22 44L36 30M27 30h9v9" fill="none" stroke="#3b1838" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function Face({ mood, cx, cy, gap, ink }: { mood: Mood; cx: number; cy: number; gap: number; ink: string }) {
  const l = cx - gap, r = cx + gap;
  if (mood === 'party') return <><path d={`M${l - 3} ${cy}q3 -4 6 0M${r - 3} ${cy}q3 -4 6 0`} stroke={ink} strokeWidth="2.4" fill="none" strokeLinecap="round" /><path d={`M${cx - 6} ${cy + 6}q6 8 12 0z`} fill={ink} /></>;
  if (mood === 'think') return <><ellipse cx={l + 1} cy={cy - 1} rx="2.3" ry="2.9" fill={ink} /><ellipse cx={r + 1} cy={cy - 1} rx="2.3" ry="2.9" fill={ink} /><path d={`M${cx - 3} ${cy + 8}h6`} stroke={ink} strokeWidth="2.2" strokeLinecap="round" /></>;
  if (mood === 'alert') return <><circle cx={l} cy={cy} r="3.4" fill={ink} /><circle cx={r} cy={cy} r="3.4" fill={ink} /><circle cx={l + 1} cy={cy - 1} r="1" fill="#fff" /><circle cx={r + 1} cy={cy - 1} r="1" fill="#fff" /><ellipse cx={cx} cy={cy + 8} rx="2.6" ry="3" fill={ink} /></>;
  return <><g className="mascot-eyes"><ellipse cx={l} cy={cy} rx="2.5" ry="3.2" fill={ink} /><ellipse cx={r} cy={cy} rx="2.5" ry="3.2" fill={ink} /></g><path d={`M${cx - 5} ${cy + 6}q5 5.5 10 0`} stroke={ink} strokeWidth="2.3" fill="none" strokeLinecap="round" /></>;
}

function Extras({ mood, cx, top, color }: { mood: Mood; cx: number; top: number; color: string }) {
  if (mood === 'party') return <g fill={color}><rect x={cx - 24} y={top + 2} width="4" height="4" rx="1" transform={`rotate(20 ${cx - 22} ${top + 4})`} /><circle cx={cx + 24} cy={top + 6} r="2.4" /><rect x={cx + 16} y={top - 4} width="3" height="6" rx="1" transform={`rotate(-25 ${cx + 17} ${top})`} /><circle cx={cx - 16} cy={top - 5} r="1.8" /></g>;
  if (mood === 'think') return <g fill={color} opacity=".8"><circle cx={cx + 20} cy={top + 2} r="2" /><circle cx={cx + 25} cy={top - 4} r="2.8" /><circle cx={cx + 31} cy={top - 11} r="3.6" /></g>;
  if (mood === 'alert') return <g fill={color}><rect x={cx + 21} y={top - 10} width="4" height="11" rx="2" /><circle cx={cx + 23} cy={top + 5} r="2.3" /></g>;
  return null;
}

/** Iaulin: a etiqueta-robô que caça promoções. */
export function Iaulin({ size = 48, mood = 'happy', label }: { size?: number; mood?: Mood; label?: string }) {
  const id = 'iaulin' + useUid();
  return <svg className={`mascot iaulin mood-${mood}`} width={size} height={size} viewBox="-4 -14 72 84" role={label ? 'img' : undefined} aria-hidden={label ? undefined : true} aria-label={label}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff4f7b" /><stop offset="1" stopColor="#7a1f6e" /></linearGradient></defs>
    <Extras mood={mood} cx={30} top={10} color="#ffc93c" />
    <g className="mascot-antenna"><path d="M40 14l5-8" stroke="#ff7a45" strokeWidth="2.6" strokeLinecap="round" /><path d="M46 1.5l1.3 2.8 3 .4-2.2 2.1.5 3-2.6-1.4-2.7 1.4.6-3-2.2-2.1 3-.4z" fill="#ffd25a" /></g>
    <path d="M12 24c0-4 3-7 7-7h22l11 11v22c0 4-3 7-7 7H19c-4 0-7-3-7-7z" fill={`url(#${id})`} />
    <circle cx="44" cy="25" r="2.8" fill="#ffe7f0" />
    <rect x="17" y="29" width="30" height="21" rx="10" fill="#fff4f8" />
    <circle cx="20" cy="44" r="2.1" fill="#ff9ebc" opacity=".8" /><circle cx="44" cy="44" r="2.1" fill="#ff9ebc" opacity=".8" />
    <Face mood={mood} cx={32} cy={39} gap={7} ink="#3b1838" />
  </svg>;
}
