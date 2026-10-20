import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Download, KeyRound } from 'lucide-react';
import { Button } from './ui.tsx';

export type RecoveryCodeKind = 'created' | 'reset' | 'renewed';
export interface RecoveryCodeNotice { code: string; email: string; kind: RecoveryCodeKind }

const copy: Record<RecoveryCodeKind, { title: string; lead: string }> = {
  created: { title: 'Conta criada! Guarde seu código de recuperação', lead: 'Este é o seu plano B: se esquecer a senha, o código abaixo devolve seu acesso sem precisar de e-mail.' },
  reset: { title: 'Senha trocada! Este é o seu novo código', lead: 'O código anterior foi usado e não vale mais. Baixe o novo arquivo para a próxima vez que precisar.' },
  renewed: { title: 'Novo código de recuperação gerado', lead: 'O código antigo deixou de funcionar. Guarde este no lugar dele.' },
};

/** Plain text for the downloaded file. CRLF and a BOM keep accents correct in the old Windows Notepad. */
export function recoveryFileText(code: string, email: string, when = new Date()): string {
  const lines = [
    'PROMO IAULIN BOT - CÓDIGO DE RECUPERAÇÃO',
    '========================================',
    '',
    `Conta: ${email}`,
    `Gerado em: ${when.toLocaleString('pt-BR')}`,
    '',
    'SEU CÓDIGO:',
    '',
    `    ${code}`,
    '',
    'COMO USAR',
    '1. Na tela de entrada, clique em "Esqueci minha senha".',
    '2. Escolha a aba "Código de recuperação".',
    '3. Digite seu e-mail, este código e uma nova senha (duas vezes).',
    '',
    'IMPORTANTE',
    '- Quem tiver este arquivo consegue entrar na sua conta. Guarde em um lugar seguro e não envie a ninguém.',
    '- O código funciona uma única vez. Ao usar, o sistema mostra um código novo para você baixar.',
    '- Se perder este arquivo, entre na sua conta e gere outro em Minha conta. O código antigo deixa de valer.',
    '- Não guardamos o código em si, só uma impressão digital dele. Por isso não conseguimos reenviá-lo.',
    '',
  ];
  return '﻿' + lines.join('\r\n');
}

export function downloadRecoveryFile(code: string, email: string): void {
  const url = URL.createObjectURL(new Blob([recoveryFileText(code, email)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'promo-iaulin-codigo-de-recuperacao.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** The code is shown here once. It cannot be skipped by accident: the person must confirm having saved it. */
export function RecoveryCodeSheet({ notice, onDone }: { notice: RecoveryCodeNotice; onDone: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => { document.body.style.overflow = oldOverflow; };
  }, []);
  async function copyCode() {
    try { await navigator.clipboard.writeText(notice.code); setCopied(true); setSaved(true); } catch { setCopied(false); }
  }
  const text = copy[notice.kind];
  return <div className="recovery-sheet-backdrop">
    <div className="recovery-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
      <div className="recovery-sheet-icon"><KeyRound size={26} strokeWidth={1.6} /></div>
      <h2 id={titleId}>{text.title}</h2>
      <p>{text.lead}</p>
      <div className="recovery-code" data-testid="recovery-code">{notice.code}</div>
      <div className="recovery-sheet-actions">
        <Button icon={Download} onClick={() => { downloadRecoveryFile(notice.code, notice.email); setSaved(true); }}>Baixar arquivo .txt</Button>
        <Button variant="secondary" icon={copied ? Check : Copy} onClick={() => void copyCode()}>{copied ? 'Copiado' : 'Copiar código'}</Button>
      </div>
      <ul className="recovery-sheet-rules">
        <li>Guarde o arquivo fora deste navegador (nuvem pessoal, pen drive ou impresso).</li>
        <li>Ele vale uma única vez e só aparece agora: não conseguimos mostrá-lo de novo.</li>
        <li>Quem tiver o arquivo entra na sua conta. Não compartilhe.</li>
      </ul>
      <label className="recovery-sheet-confirm">
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        <span>Já guardei meu código em um lugar seguro{saved ? '' : ' (baixe ou copie antes)'}.</span>
      </label>
      <Button disabled={!confirmed || !saved} onClick={onDone}>Continuar</Button>
    </div>
  </div>;
}
