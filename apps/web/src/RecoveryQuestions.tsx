import { useState } from 'react';
import { SECURITY_QUESTIONS } from '../../../packages/shared/src/security-questions.ts';
import { Field } from './ui.tsx';

export interface QuestionAnswer { id:string; answer:string }
export function readRecoveryQuestions(form:FormData):QuestionAnswer[] {
  const result=[0,1,2].map(index=>({id:String(form.get('question'+index)||''),answer:String(form.get('answer'+index)||'')}));
  if(new Set(result.map(item=>item.id)).size!==3 || result.some(item=>!SECURITY_QUESTIONS.some(q=>q.id===item.id))) {
    throw new Error('Escolha três perguntas diferentes.');
  }
  if(result.some(item=>item.answer.normalize('NFKC').trim().length<6))throw new Error('Use respostas com pelo menos 6 caracteres.');
  return result;
}

export function RecoveryQuestionFields({selected=[]}:{selected?:string[]}) {
  const [questions,setQuestions]=useState<string[]>([selected[0]??'',selected[1]??'',selected[2]??'']);
  return <div className="feature-stack">
    {[0,1,2].map(index=><div className="feature-stack" key={index}>
      <Field label={`Pergunta de segurança ${index+1}`}>
        <select name={`question${index}`} value={questions[index]} required onChange={event=>setQuestions(previous=>previous.map((item,i)=>i===index?event.target.value:item))}>
          <option value="">Escolha uma pergunta</option>
          {SECURITY_QUESTIONS.map(question=><option key={question.id} value={question.id} disabled={questions.some((id,i)=>i!==index&&id===question.id)}>{question.label}</option>)}
        </select>
      </Field>
      <Field label={`Resposta ${index+1}`} hint="Mínimo de 6 caracteres. Maiúsculas, minúsculas e acentos não fazem diferença.">
        <input name={`answer${index}`} type="password" minLength={6} maxLength={120} autoComplete="off" required/>
      </Field>
    </div>)}
  </div>;
}
