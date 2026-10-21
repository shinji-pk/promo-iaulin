import { Iaulin } from './Brand.tsx';
import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, LoaderCircle, X, type LucideIcon } from 'lucide-react';

export function Button({ children, onClick, variant = 'primary', icon: Icon, disabled, type = 'button', className = '', title }: { children?: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: LucideIcon; disabled?: boolean; type?: 'button' | 'submit'; className?: string; title?: string }) {
  return <button title={title} className={`button button-${variant} ${className}`} onClick={onClick} disabled={disabled} type={type}>{Icon && <Icon size={16} strokeWidth={1.8} />}{children}</button>;
}
export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'purple' | 'red'; dot?: boolean }) { return <span className={`badge badge-${tone}`}>{dot && <span className="status-dot" />}{children}</span>; }
export function SectionTitle({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="section-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
export function EmptyState({ icon: Icon, title, description, action, compact = false }: { icon: LucideIcon; title: string; description: string; action?: ReactNode; compact?: boolean }) { return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-mascot"><Iaulin size={72} mood="think" /><span className="empty-badge"><Icon size={14} strokeWidth={1.8} /></span></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const generatedId = useId();
  const control = isValidElement(children) ? children as ReactElement<{ id?: string; 'aria-describedby'?: string }> : null;
  const id = control?.props.id || generatedId;
  const hintId = `${id}-hint`;
  return <div className={`field ${className}`}><label htmlFor={id}>{label}</label><div className="field-control">{control ? cloneElement(control, { id, ...(hint ? { 'aria-describedby': [control.props['aria-describedby'], hintId].filter(Boolean).join(' ') } : {}) }) : children}</div>{hint && <p id={hintId} className="field-hint">{hint}</p>}</div>;
}
export function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) { const id = useId(); return <div className="toggle-row"><div><label htmlFor={id}>{label}</label>{description && <p>{description}</p>}</div><button id={id} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} type="button"><span>{checked && <Check size={10} />}</span></button></div>; }
export function SaveBar({ onSave, saving, dirty = true, label = 'Salvar preferências' }: { onSave: () => void; saving: boolean; dirty?: boolean; label?: string }) { return <div className="save-bar"><span>{dirty ? 'Suas escolhas, do seu jeito.' : 'Preferências salvas.'}</span><Button onClick={onSave} disabled={saving} icon={saving ? LoaderCircle : Check}>{saving ? 'Salvando...' : label}</Button></div>; }
export function Modal({ children, title, subtitle, onClose, wide = false }: { children: ReactNode; title: string; subtitle?: string; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const titleId = useId();
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') || []);
    (focusable()[0] || panel.current)?.focus();
    const handler = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) !== panel.current) return;
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? `${titleId}-description` : undefined}><div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={`${titleId}-description`}>{subtitle}</p>}</div><button className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}
export function TextLink({ children, onClick, external = false }: { children: ReactNode; onClick: () => void; external?: boolean }) { return <button className="text-link" onClick={onClick}>{children}{external ? <ArrowUpRight size={15} /> : <ChevronRight size={15} />}</button>; }
export function Loading() { return <div className="loading-state" aria-label="Carregando PromoBridge" aria-busy="true"><span className="brand-mark">p<span>↗</span></span><span>Seu espaço está quase pronto...</span><LoaderCircle className="spin" size={20} /></div>; }
export function formatMoney(value: number | null) { return value === null ? 'Preço não informado' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value); }
export function timeAgo(date: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000)); return minutes < 1 ? 'agora' : minutes < 60 ? `há ${minutes} min` : minutes < 1440 ? `há ${Math.floor(minutes / 60)} h` : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(date)); }
