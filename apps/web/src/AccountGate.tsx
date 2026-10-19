import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, LogOut, Monitor, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { Button, Field, Loading, Modal } from './ui.tsx';
import './account.css';

interface Account {mode:'cloud';user:{id:string;name:string;email:string}|null;persistence:'cloud';workerConnected:boolean;workerUrl?:string|null;workerExpiresAt?:string|null;}
const AccountContext=createContext<{cloud:boolean;workerConnected:boolean;user:Account['user'];open:()=>void}>({cloud:false,workerConnected:false,user:null,open:()=>undefined});
export const useAccount=()=>useContext(AccountContext);
const local=['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)||window.location.hostname.endsWith('.localhost');

async function jsonRequest(path:string,body?:unknown,method=body===undefined?'GET':'POST'){
  let csrf='';
  if(path.startsWith('/api/v1/')&&method!=='GET'){
    const response=await fetch('/api/v1/session',{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
    const session=await response.json();if(!response.ok)throw new Error('Entre na sua conta novamente.');csrf=session.csrfToken;
  }
  const response=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  let data:any;try{data=await response.json();}catch{throw new Error('O serviço está indisponível. Tente novamente em instantes.');}
  if(!response.ok){
    const messages:Record<string,string>={INVALID_EMAIL_OR_PASSWORD:'E-mail ou senha incorretos.',USER_ALREADY_EXISTS:'Este e-mail já tem uma conta. Use Entrar.',USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:'Este e-mail já tem uma conta. Use Entrar.',PASSWORD_TOO_SHORT:'Use uma senha com pelo menos 12 caracteres.',TOO_MANY_REQUESTS:'Muitas tentativas. Aguarde um minuto e tente novamente.'};
    throw new Error(messages[data.code]??data.error??(response.status===429?'Muitas tentativas. Aguarde um minuto.':response.status>=500?'Não foi possível acessar sua conta agora. Tente novamente.':'Confira seus dados e tente novamente.'));
  }
  return data;
}

export function AccountGate({children}:{children:ReactNode}){
  const [account,setAccount]=useState<Account|null|undefined>(undefined),[error,setError]=useState(''),[panel,setPanel]=useState(false),[screen,setScreen]=useState<'login'|'signup'>('login'),[busy,setBusy]=useState(false);
  const loadVersion=useRef(0);
  const load=useCallback(async()=>{
    const version=++loadVersion.current;
    setError('');
    try{
      const response=await fetch('/api/v1/account',{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
      if(version!==loadVersion.current)return;
      if(response.status===404&&local){setAccount(null);return;}
      if(!response.ok)throw new Error('O serviço de contas está indisponível. Tente novamente em instantes.');
      const data=await response.json() as Account;
      if(version!==loadVersion.current)return;
      if(data.mode!=='cloud')throw new Error('Não foi possível identificar o serviço de contas.');
      setAccount(data);
    }catch(cause){if(version===loadVersion.current)setError(cause instanceof Error?cause.message:'Não foi possível acessar sua conta.');}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const expired=()=>{setAccount(previous=>previous?{...previous,user:null}:previous);setError('Sua sessão terminou. Entre novamente para continuar.');setPanel(false);};window.addEventListener('promobridge:session-expired',expired);return()=>window.removeEventListener('promobridge:session-expired',expired);},[]);
  async function authenticate(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget);
    try{
      await jsonRequest(`/api/auth/${screen==='signup'?'sign-up':'sign-in'}/email`,{email:String(form.get('email')).trim(),password:String(form.get('password')),...(screen==='signup'?{name:String(form.get('name')).trim()}:{})});
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível entrar.');}finally{setBusy(false);}
  }
  async function logout(){setBusy(true);try{await jsonRequest('/api/auth/sign-out',{});setAccount(previous=>previous?{...previous,user:null}:previous);setPanel(false);}catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível sair.');}finally{setBusy(false);}}
  if(account===null)return children;
  if(account===undefined&&!error)return <Loading/>;
  if(!account?.user)return <div className="account-screen"><div className="account-welcome"><a className="account-brand" href="/"><span className="brand-mark">p<span>↗</span></span><b>Promo · Iaulin Bot</b></a><span className="eyebrow">SEU GRUPO DE OFERTAS, COM MAIS LEVEZA</span><h1>Boas ofertas.<br/>Tudo no seu lugar.</h1><p>Organize seus links de afiliado, selecione as melhores ofertas e cuide do seu grupo de vendas no WhatsApp.</p><div className="account-promise"><ShieldCheck size={22}/><span>Suas preferências ficam salvas na sua conta, separadas das outras pessoas.</span></div></div><div className="account-login"><div className="account-tabs" role="tablist" aria-label="Acessar sua conta"><button role="tab" aria-selected={screen==='login'} onClick={()=>{setScreen('login');setError('');}}>Entrar</button><button role="tab" aria-selected={screen==='signup'} onClick={()=>{setScreen('signup');setError('');}}>Criar conta</button></div><h2>{screen==='login'?'Que bom ter você por aqui.':'Vamos preparar seu espaço.'}</h2><p>{screen==='login'?'Entre para continuar de onde parou.':'Crie sua conta para guardar suas escolhas.'}</p><form onSubmit={event=>void authenticate(event)}>{screen==='signup'&&<Field label="Seu nome"><input name="name" autoComplete="name" minLength={2} maxLength={100} required/></Field>}<Field label="E-mail"><input name="email" type="email" autoComplete="email" maxLength={254} required/></Field><Field label="Senha" hint={screen==='signup'?'Use pelo menos 12 caracteres. Uma frase é fácil de lembrar.':undefined}><input name="password" type="password" autoComplete={screen==='signup'?'new-password':'current-password'} minLength={screen==='signup'?12:1} maxLength={128} required/></Field>{error&&<div className="notice notice-warning" role="alert"><p>{error}</p></div>}<Button type="submit" disabled={busy} icon={ArrowRight}>{busy?'Aguarde…':screen==='signup'?'Criar minha conta':'Entrar na minha conta'}</Button></form><p className="account-save-note">O WhatsApp funciona com o aplicativo aberto no computador. O guia mostra como conectar tudo.</p>{error&&<Button variant="ghost" icon={RefreshCw} onClick={()=>void load()}>Verificar conexão</Button>}</div></div>;
  return <AccountContext.Provider value={{cloud:true,workerConnected:account.workerConnected,user:account.user,open:()=>setPanel(true)}}>{children}{panel&&<Modal title="Minha conta" subtitle="Suas escolhas ficam salvas no servidor e acompanham seu login." onClose={()=>{setPanel(false);setError('');}}><AccountSettings account={account} onRefresh={load}/>{error&&<p role="alert">{error}</p>}<div className="modal-footer"><Button variant="ghost" icon={LogOut} disabled={busy} onClick={()=>void logout()}>Sair da conta</Button><Button onClick={()=>setPanel(false)}>Concluir</Button></div></Modal>}</AccountContext.Provider>;
}

function AccountSettings({account,onRefresh}:{account:Account;onRefresh:()=>Promise<void>}){
  const [name,setName]=useState(account.user?.name??''),[pairingUrl,setPairingUrl]=useState(''),[useSavedSettings,setUseSavedSettings]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  async function run(operation:()=>Promise<unknown>,message:string){setBusy(true);setError('');setNotice('');try{await operation();await onRefresh();setNotice(message);}catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível concluir.');}finally{setBusy(false);}}
  return <div className="account-settings feature-stack"><Field label="Seu nome"><input value={name} onChange={event=>setName(event.target.value)} maxLength={100}/></Field><Field label="E-mail da conta"><input value={account.user?.email??''} disabled type="email"/></Field><Button variant="secondary" icon={UserRound} disabled={busy||name.trim().length<2} onClick={()=>void run(()=>jsonRequest('/api/v1/account/profile',{name:name.trim()},'PUT'),'Nome atualizado.')}>Salvar meu nome</Button><div className="account-device"><Monitor size={23}/><div><b>{account.workerConnected?'Computador pareado':'Conecte seu computador'}</b><p>{account.workerConnected?'O aplicativo precisa continuar aberto. Se o computador cair, as publicações aguardam a conexão.':'O computador conecta seu WhatsApp, recebe as ofertas e executa as publicações. O site guarda suas preferências mesmo sem ele.'}</p>{account.workerUrl&&<small>{account.workerUrl}</small>}</div></div><details className="advanced-details"><summary>{account.workerConnected?'Gerenciar conexão':'Passo a passo para conectar'}</summary><ol className="account-steps"><li><a href="https://github.com/shinji-pk/promo-iaulin/archive/refs/heads/main.zip" target="_blank" rel="noreferrer">Baixe o aplicativo</a>, extraia a pasta e abra <b>INICIAR-PROMOBRIDGE.bat</b> no Windows.</li><li>No painel do computador, abra <b>Fontes & conexões → Acessar pelo celular</b> e ative o acesso.</li><li>Copie o link de pareamento exibido e cole abaixo. Ele vale por cinco minutos e só pode ser usado uma vez.</li></ol><Field label="Link de pareamento do computador"><input value={pairingUrl} onChange={event=>setPairingUrl(event.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder="https://…/#pair=…"/></Field><label className="feature-confirm"><input type="checkbox" checked={useSavedSettings} onChange={event=>setUseSavedSettings(event.target.checked)}/><span>Aplicar minhas preferências salvas ao computador. Se não marcar, o painel carregará as configurações atuais do computador.</span></label><div className="feature-inline-actions"><Button disabled={busy||!pairingUrl} onClick={()=>void run(async()=>{await jsonRequest('/api/v1/account/worker',{pairingUrl,useSavedSettings});setPairingUrl('');window.location.reload();},'Computador conectado.')}>Conectar computador</Button>{account.workerUrl&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>jsonRequest('/api/v1/account/worker',{},'DELETE'),'Computador desvinculado desta conta.')}>Desvincular</Button>}</div><p className="field-hint">O acesso temporário muda ao reiniciar e precisa de novo pareamento. Para uso contínuo, o painel local também oferece túnel próprio.</p></details><details className="advanced-details"><summary>Alterar minha senha</summary><form className="feature-stack" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run(async()=>{await jsonRequest('/api/v1/account/password',{currentPassword:String(form.get('current')),newPassword:String(form.get('next'))});window.location.reload();},'Senha alterada.');}}><Field label="Senha atual"><input name="current" type="password" autoComplete="current-password" required/></Field><Field label="Nova senha" hint="Pelo menos 12 caracteres."><input name="next" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field><Button type="submit" disabled={busy}>Alterar senha</Button></form></details>{notice&&<div className="notice notice-subtle" role="status"><Check size={18}/><p>{notice}</p></div>}{error&&<div className="notice notice-warning" role="alert"><p>{error}</p></div>}</div>;
}
