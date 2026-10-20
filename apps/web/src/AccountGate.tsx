import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, LogOut, Monitor, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { Button, Field, Loading, Modal } from './ui.tsx';
import { RecoveryQuestionFields, readRecoveryQuestions } from './RecoveryQuestions.tsx';
import { LocalSetupButton } from './FeaturePanels.tsx';
import './account.css';

interface Account {mode:'cloud';user:{id:string;name:string;email:string;username?:string;phone?:string;image?:string|null}|null;persistence:'cloud';managed?:boolean;workerConnected:boolean;workerUrl?:string|null;workerExpiresAt?:string|null;}
const AccountContext=createContext<{cloud:boolean;managed:boolean;workerConnected:boolean;user:Account['user'];open:()=>void}>({cloud:false,managed:false,workerConnected:false,user:null,open:()=>undefined});
export const useAccount=()=>useContext(AccountContext);
const local=['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)||window.location.hostname.endsWith('.localhost');

async function jsonRequest(path:string,body?:unknown,method=body===undefined?'GET':'POST'){
  let csrf='';
  if(path.startsWith('/api/v1/')&&path!=='/api/v1/account/recover-with-questions'&&method!=='GET'){
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

// This runs once at module load rather than in a React StrictMode initializer.
// The one-time token is erased from browser history before the login UI mounts.
function readDesktopPairFromHash():string {
  const fragment=new URLSearchParams(location.hash.slice(1));
  const pair=fragment.get('worker-pair')??'';
  if(pair) history.replaceState(history.state,'',location.pathname+location.search+'#sources');
  return pair;
}
const desktopPairFromLink=readDesktopPairFromHash();

export function AccountGate({children}:{children:ReactNode}){
  const [account,setAccount]=useState<Account|null|undefined>(undefined),[error,setError]=useState(''),[panel,setPanel]=useState(false),[screen,setScreen]=useState<'login'|'signup'|'recovery'|'reset'|'question-recovery'>(new URLSearchParams(location.search).has('token')?'reset':'login'),[busy,setBusy]=useState(false);
  const [token]=useState(()=>{const url=new URL(location.href);const value=url.searchParams.get('token')??'';if(value){url.searchParams.delete('token');url.searchParams.delete('error');history.replaceState(history.state,'',url.pathname+url.search+url.hash);}return value;});
  // Recebe somente o vínculo temporário criado pelo aplicativo Windows (fragmento nunca é enviado como Referer).
  const [pendingDesktopPair,setPendingDesktopPair]=useState(desktopPairFromLink);
  const [pairBusy,setPairBusy]=useState(false),[pairError,setPairError]=useState('');
  // Some browsers navigate to a pairing URL in the existing app tab.
  // Detect same-document hash changes too, and remove the one-time secret from the URL immediately.
  useEffect(()=>{
    const incoming=()=>{
      const pair=readDesktopPairFromHash();
      if(pair){setPendingDesktopPair(pair);setPairError('');}
    };
    window.addEventListener('hashchange',incoming);
    return()=>window.removeEventListener('hashchange',incoming);
  },[]);
  const [recoveryReady,setRecoveryReady]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{void fetch('/api/v1/account/capabilities').then(r=>r.json()).then(v=>setRecoveryReady(v.passwordRecovery===true)).catch(()=>undefined);},[]);
  const loadVersion=useRef(0);
  const load=useCallback(async()=>{
    const version=++loadVersion.current;
    setError('');
    try{
      const response=await fetch('/api/v1/account',{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
      if(version!==loadVersion.current)return;
      if(response.status===401){
        const body=await response.json();
        // A device tunnel uses its single-use pairing flow, rather than cloud accounts.
        if(body.code==='PAIRING_REQUIRED'){setAccount(null);return;}
      }
      if(response.status===404&&local){setAccount(null);return;}
      if(!response.ok)throw new Error('O serviço de contas está indisponível. Tente novamente em instantes.');
      const data=await response.json();
      if(version!==loadVersion.current)return;
      if(data.mode==='worker'){setAccount(null);return;}
      if(data.mode!=='cloud')throw new Error('Não foi possível identificar o serviço de contas.');
      setAccount(data);
    }catch(cause){if(version===loadVersion.current)setError(cause instanceof Error?cause.message:'Não foi possível acessar sua conta.');}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const expired=()=>{setAccount(previous=>previous?{...previous,user:null}:previous);setError('Sua sessão terminou. Entre novamente para continuar.');setPanel(false);setScreen('login');};window.addEventListener('promobridge:session-expired',expired);return()=>window.removeEventListener('promobridge:session-expired',expired);},[]);
  async function recover(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!recoveryReady)return;setBusy(true);setError('');setNotice('');
    try{const email=String(new FormData(event.currentTarget).get('email')).trim();await jsonRequest('/api/auth/request-password-reset',{email,redirectTo:location.origin+'/'});
      setNotice('Se existir uma conta com este e-mail, enviaremos um link. Confira também o spam.');
    }catch{setError('Não foi possível solicitar o e-mail. Tente novamente mais tarde.');}finally{setBusy(false);}
  }
  async function recoverWithQuestions(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
    try {
      const form=new FormData(event.currentTarget);
      const newPassword=String(form.get('password')),confirmPassword=String(form.get('confirm'));
      if(newPassword!==confirmPassword)throw new Error('As novas senhas não conferem.');
      const questions=readRecoveryQuestions(form);
      await jsonRequest('/api/v1/account/recover-with-questions',{email:String(form.get('email')).trim(),questions,newPassword,confirmPassword});
      setScreen('login');setNotice('Senha redefinida. Entre com sua nova senha.');setError('');
    }catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível confirmar a recuperação.');}
    finally{setBusy(false);}
  }
  async function resetPassword(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget),newPassword=String(form.get('password'));
    if(newPassword!==String(form.get('confirm'))){setError('As senhas não conferem.');return;}
    setBusy(true);setError('');try{await jsonRequest('/api/auth/reset-password',{token,newPassword});
      setScreen('login');setNotice('Senha alterada. Entre com sua nova senha.');
    }catch{setError('O link expirou ou não é válido. Solicite outro em Esqueci minha senha.');}finally{setBusy(false);}
  }
  async function authenticate(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget);
    try{
      if(screen==='signup' && String(form.get('password'))!==String(form.get('confirmPassword')))throw new Error('As senhas não conferem. Digite a mesma senha nos dois campos.');
      await jsonRequest(`/api/auth/${screen==='signup'?'sign-up':'sign-in'}/email`,{email:String(form.get('email')).trim(),password:String(form.get('password')),...(screen==='signup'?{name:String(form.get('name')).trim()}:{})});
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível entrar.');}finally{setBusy(false);}
  }
  async function confirmDesktopPair(){
    if(!account?.user || !pendingDesktopPair || pairBusy)return;
    setPairBusy(true);setPairError('');
    try{
      await jsonRequest('/api/v1/account/worker',{pairingUrl:pendingDesktopPair,useSavedSettings:false});
      setPendingDesktopPair('');
      await load();
    }catch(cause){setPairError(cause instanceof Error?cause.message:'Não foi possível conectar. Volte ao aplicativo e gere outro vínculo.');}
    finally{setPairBusy(false);}
  }
  async function logout(){setBusy(true);try{await jsonRequest('/api/auth/sign-out',{});setAccount(previous=>previous?{...previous,user:null}:previous);setPanel(false);setScreen('login');}catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível sair.');}finally{setBusy(false);}}
  if(account===null)return children;
  if(account===undefined&&!error)return <Loading/>;
  if(!account?.user)return <div className="account-screen"><div className="account-welcome"><a className="account-brand" href="/"><span className="brand-mark">p<span>↗</span></span><b>Promo · Iaulin Bot</b></a><span className="eyebrow">SEU GRUPO DE OFERTAS, COM MAIS LEVEZA</span><h1>Boas ofertas.<br/>Tudo no seu lugar.</h1><p>Organize seus links de afiliado, selecione as melhores ofertas e cuide do seu grupo de vendas no WhatsApp.</p><div className="account-promise"><ShieldCheck size={22}/><span>Suas preferências ficam salvas na sua conta, separadas das outras pessoas.</span></div></div><div className="account-login"><div className="account-tabs" role="tablist" aria-label="Acessar sua conta"><button role="tab" aria-selected={screen==='login'} onClick={()=>{setScreen('login');setError('');}}>Entrar</button><button role="tab" aria-selected={screen==='signup'} onClick={()=>{setScreen('signup');setError('');}}>Criar conta</button></div><h2>{screen==='login'?'Que bom ter você por aqui.':screen==='signup'?'Vamos preparar seu espaço.':screen==='recovery'?'Recuperar sua senha':screen==='question-recovery'?'Recuperar com três perguntas':'Crie sua nova senha'}</h2><p>{screen==='login'?'Entre para continuar de onde parou.':screen==='signup'?'Crie sua conta para guardar suas escolhas.':screen==='recovery'?'Vamos enviar um link ao seu e-mail cadastrado.':screen==='question-recovery'?'Responda as três perguntas que você cadastrou na sua conta.':'Escolha uma senha com pelo menos 12 caracteres.'}</p>{(screen==='login'||screen==='signup')&&<form onSubmit={event=>void authenticate(event)}>{screen==='signup'&&<Field label="Seu nome"><input name="name" autoComplete="name" minLength={2} maxLength={100} required/></Field>}<Field label="E-mail"><input name="email" type="email" autoComplete="email" maxLength={254} required/></Field><Field label="Senha" hint={screen==='signup'?'Use pelo menos 12 caracteres. Uma frase é fácil de lembrar.':undefined}><input name="password" type="password" autoComplete={screen==='signup'?'new-password':'current-password'} minLength={screen==='signup'?12:1} maxLength={128} required/></Field>{screen==='signup'&&<Field label="Confirmar senha"><input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field>}{error&&<div className="notice notice-warning" role="alert"><p>{error}</p></div>}<Button type="submit" disabled={busy} icon={ArrowRight}>{busy?'Aguarde…':screen==='signup'?'Criar minha conta':'Entrar na minha conta'}</Button></form>}{screen==='login'&&<button type="button" className="account-plain-link" onClick={()=>{setScreen('recovery');setError('');setNotice('');}}>Esqueci minha senha</button>}{screen==='recovery'&&<><form onSubmit={recover}><Field label="E-mail da conta"><input type="email" name="email" maxLength={254} required/></Field><Button type="submit" disabled={busy||!recoveryReady}>Enviar link de recuperação</Button></form>{!recoveryReady&&<p role="status" className="field-hint">O envio de e-mails ainda não está configurado pelo administrador. Nenhum link será enviado até a configuração.</p>}<button type="button" className="account-plain-link" onClick={()=>{setScreen('question-recovery');setError('');}}>Recuperar com minhas três perguntas</button></>}{screen==='question-recovery'&&<form onSubmit={event=>void recoverWithQuestions(event)} className="feature-stack"><Field label="E-mail cadastrado"><input name="email" type="email" required maxLength={254}/></Field><RecoveryQuestionFields/><Field label="Nova senha"><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/></Field><Field label="Confirme sua nova senha"><input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/></Field><Button type="submit" disabled={busy}>{busy?'Aguarde…':'Verificar respostas e trocar senha'}</Button><p className="field-hint">Esta opção funciona apenas para quem já cadastrou as três perguntas em Minha conta. Respostas devem ser privadas e difíceis de adivinhar.</p></form>}{screen==='reset'&&<form onSubmit={resetPassword}><Field label="Nova senha"><input type="password" name="password" minLength={12} maxLength={128} required/></Field><Field label="Confirmar senha"><input type="password" name="confirm" minLength={12} maxLength={128} required/></Field><Button type="submit" disabled={busy||!token}>Definir nova senha</Button></form>}{notice&&<div className="notice notice-subtle" role="status"><p>{notice}</p></div>}{error&&screen==='question-recovery'&&<div className="notice notice-warning" role="alert"><p>{error}</p></div>}{(screen==='recovery'||screen==='reset'||screen==='question-recovery')&&<button type="button" className="account-plain-link" onClick={()=>{setScreen('login');setError('');}}>Voltar para entrar</button>}<p className="account-save-note">Pode fechar o site sem perder suas preferências. Para receber e publicar no WhatsApp, mantenha apenas o PromoBridge funcionando no computador.</p>{error&&<Button variant="ghost" icon={RefreshCw} onClick={()=>void load()}>Verificar conexão</Button>}</div></div>;
  return <AccountContext.Provider value={{cloud:true,managed:Boolean(account.managed),workerConnected:account.workerConnected,user:account.user,open:()=>setPanel(true)}}>{children}{pendingDesktopPair&&!account.workerConnected&&<Modal title="Vincular este computador?" subtitle="O Promo Iaulin abriu esta página para conectar seu servidor local à conta online." onClose={()=>setPendingDesktopPair('')}><div className="feature-stack"><p>Confirme somente se você acabou de clicar em <b>Vincular minha conta online</b> no aplicativo instalado no seu próprio computador.</p><p className="field-hint">A sessão continua no seu computador. Para acessar pelo site, o programa deve permanecer ligado e o acesso temporário seguro precisa estar disponível.</p>{pairError&&<div className="notice notice-warning" role="alert"><p>{pairError}</p></div>}<div className="modal-footer"><Button variant="ghost" onClick={()=>setPendingDesktopPair('')} disabled={pairBusy}>Cancelar</Button><Button onClick={()=>void confirmDesktopPair()} disabled={pairBusy}>{pairBusy?'Conectando…':'Confirmar conexão'}</Button></div></div></Modal>}{panel&&<Modal title="Minha conta" subtitle="Suas escolhas ficam salvas no servidor e acompanham seu login." onClose={()=>{setPanel(false);setError('');}}><AccountSettings account={account} onRefresh={load} emailReady={recoveryReady}/><SecurityQuestionsSettings/>{error&&<p role="alert">{error}</p>}<div className="modal-footer"><Button variant="ghost" icon={LogOut} disabled={busy} onClick={()=>void logout()}>Sair da conta</Button><Button onClick={()=>setPanel(false)}>Concluir</Button></div></Modal>}</AccountContext.Provider>;
}

function AccountSettings({account,onRefresh,emailReady}:{account:Account;onRefresh:()=>Promise<void>;emailReady:boolean}){
  const [name,setName]=useState(account.user?.name??''),[username,setUsername]=useState(account.user?.username??''),[phone,setPhone]=useState(account.user?.phone??''),[image,setImage]=useState<string|null>(account.user?.image??null),[email,setEmail]=useState(''),[pairingUrl,setPairingUrl]=useState(''),[useSavedSettings,setUseSavedSettings]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  async function run(operation:()=>Promise<unknown>,message:string){setBusy(true);setError('');setNotice('');try{await operation();await onRefresh();setNotice(message);}catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível concluir.');}finally{setBusy(false);}}
  async function selectPhoto(file?:File) {
    if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024){setError('Escolha uma foto JPG, PNG ou WebP de até 5 MB.');return;}
    try {
      const bitmap=await createImageBitmap(file);
      const scale=Math.min(1,320/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Imagem indisponível.');
      ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      const result=canvas.toDataURL('image/jpeg',.76);
      if(result.length>210000)throw new Error('Escolha uma foto menor.');
      setImage(result);setError('');
    }catch{setError('Não foi possível preparar sua foto. Experimente outra imagem JPG ou PNG.');}
  }
  return <div className="account-settings feature-stack"><div className="account-photo-editor">{image&&<img src={image} alt="Sua foto de perfil"/>}<label>Foto de perfil (ajuste automático) <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>void selectPhoto(event.target.files?.[0])}/></label>{image&&<Button variant="ghost" onClick={()=>setImage(null)}>Remover foto</Button>}</div><Field label="Seu nome"><input value={name} onChange={event=>setName(event.target.value)} maxLength={100}/></Field><Field label="Nome de usuário"><input value={username} onChange={e=>setUsername(e.target.value)} maxLength={40} placeholder="ex.: meu.perfil"/></Field><Field label="Telefone de contato (não verificado)"><input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} maxLength={24} placeholder="+55 62 99999-9999"/></Field><Field label="E-mail da conta"><input value={account.user?.email??''} disabled type="email"/></Field><Button variant="secondary" icon={UserRound} disabled={busy||name.trim().length<2} onClick={()=>void run(()=>jsonRequest('/api/v1/account/profile',{name:name.trim(),username:username.trim(),phone:phone.trim(),image},'PUT'),'Perfil atualizado.')}>Salvar dados do perfil</Button><details className="advanced-details"><summary>Trocar meu e-mail</summary><p>A alteração exige confirmação por e-mail para proteger sua conta. {!emailReady&&'O serviço de e-mail ainda precisa ser configurado pelo administrador.'}</p><Field label="Novo e-mail"><input type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field><Button variant="secondary" disabled={busy||!emailReady||!email.includes('@')} onClick={()=>void run(()=>jsonRequest('/api/auth/change-email',{newEmail:email.trim(),callbackURL:location.origin+'/'}),'Solicitação enviada. Confira a confirmação por e-mail.')}>Solicitar alteração</Button></details><div className="account-device"><Monitor size={23}/><div><b>{account.workerConnected?'Computador pareado':'Conecte seu computador'}</b><p>{account.workerConnected?'O PromoBridge precisa continuar em execução no computador para receber e publicar. Pode fechar o site; desligar o computador pausa a automação, não apaga os dados salvos.':'O computador conecta seu WhatsApp, recebe as ofertas e executa as publicações. O site guarda suas preferências mesmo sem ele.'}</p>{account.workerUrl&&<small>{account.workerUrl}</small>}</div></div><details className="advanced-details" open={!account.workerConnected}><summary>{account.workerConnected?'Gerenciar conexão':'Passo a passo para conectar'}</summary><LocalSetupButton/><p className="field-hint">O guia explica cada toque, desde baixar o programa até escanear o WhatsApp. Se quiser acessar por este site também, no aplicativo clique em <b>Vincular minha conta online</b> e confirme por aqui.</p><details className="advanced-details"><summary>Preciso conectar de outra maneira</summary><Field label="Link de pareamento do computador"><input value={pairingUrl} onChange={event=>setPairingUrl(event.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder="https://…/#pair=…"/></Field><label className="feature-confirm"><input type="checkbox" checked={useSavedSettings} onChange={event=>setUseSavedSettings(event.target.checked)}/><span>Aplicar minhas preferências salvas ao computador. Se não marcar, o painel carregará as configurações atuais do computador.</span></label><div className="feature-inline-actions"><Button disabled={busy||!pairingUrl} onClick={()=>void run(async()=>{await jsonRequest('/api/v1/account/worker',{pairingUrl,useSavedSettings});setPairingUrl('');window.location.reload();},'Computador conectado.')}>Conectar computador</Button>{account.workerUrl&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>jsonRequest('/api/v1/account/worker',{},'DELETE'),'Computador desvinculado desta conta.')}>Desvincular</Button>}</div><p className="field-hint">O acesso temporário muda ao reiniciar e precisa de novo pareamento. Para uso contínuo, o painel local também oferece túnel próprio.</p></details></details><details className="advanced-details"><summary>Alterar minha senha</summary><form className="feature-stack" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run(async()=>{const next=String(form.get('next'));if(next!==String(form.get('confirmNext')))throw new Error('As novas senhas não conferem.');await jsonRequest('/api/v1/account/password',{currentPassword:String(form.get('current')),newPassword:next,confirmPassword:String(form.get('confirmNext'))});window.location.reload();},'Senha alterada.');}}><Field label="Senha atual"><input name="current" type="password" autoComplete="current-password" required/></Field><Field label="Nova senha" hint="Pelo menos 12 caracteres."><input name="next" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field><Field label="Confirme a nova senha"><input name="confirmNext" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field><Button type="submit" disabled={busy}>Alterar senha</Button></form></details>{notice&&<div className="notice notice-subtle" role="status"><Check size={18}/><p>{notice}</p></div>}{error&&<div className="notice notice-warning" role="alert"><p>{error}</p></div>}</div>;
}

function SecurityQuestionsSettings(){
  const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  useEffect(()=>{void fetch('/api/v1/account/security-questions',{credentials:'same-origin'}).then(r=>r.ok?r.json():Promise.reject()).then(data=>setSelected(data.selected??[])).catch(()=>setError('Não foi possível conferir as perguntas agora.'));},[]);
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setNotice('');setError('');
    try{
      const form=new FormData(event.currentTarget),questions=readRecoveryQuestions(form);
      await jsonRequest('/api/v1/account/security-questions',{currentPassword:String(form.get('currentPassword')),questions});
      setSelected(questions.map(q=>q.id));setNotice('Suas três perguntas foram salvas com segurança. Você já pode usá-las para recuperar a senha.');
      (event.currentTarget as HTMLFormElement).reset();
    }catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível salvar as perguntas.');}finally{setBusy(false);}
  }
  return <details className="advanced-details"><summary>Minhas três perguntas de recuperação {selected.length===3?'✓':'(configure agora)'}</summary><p>Escolha três perguntas diferentes e responda com informações que outras pessoas não consigam adivinhar. As respostas não diferenciam letras maiúsculas e minúsculas.</p><form className="feature-stack" onSubmit={event=>void save(event)}><RecoveryQuestionFields key={selected.join('|')} selected={selected}/><Field label="Confirme sua senha atual"><input name="currentPassword" type="password" autoComplete="current-password" required/></Field><Button type="submit" disabled={busy}>{busy?'Salvando…':selected.length===3?'Atualizar minhas perguntas':'Salvar minhas três perguntas'}</Button></form>{notice&&<p className="notice notice-subtle" role="status">{notice}</p>}{error&&<p className="notice notice-warning" role="alert">{error}</p>}<p className="field-hint">Não use informações fáceis de encontrar em redes sociais. Se ainda não cadastrou as perguntas, não será possível utilizá-las para recuperar sua senha.</p></details>;
}
