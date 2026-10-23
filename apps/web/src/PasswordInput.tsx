import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import './password-input.css';

export function PasswordInput({ type = 'password', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  if (type !== 'password') return <input {...props} type={type} />;
  return <span className="password-reveal">
    <input {...props} type={visible ? 'text' : 'password'} />
    <button
      type="button"
      className="password-reveal-button"
      aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
      title={visible ? 'Ocultar senha' : 'Mostrar senha'}
      aria-pressed={visible}
      disabled={props.disabled}
      onClick={() => setVisible(previous => !previous)}
    >{visible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}</button>
  </span>;
}
