import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function part(from,to){
 const i=source.indexOf(from);if(i<0)throw Error('Function missing: '+from);
 const j=to?source.indexOf(to,i+from.length):source.length;
 if(j<0)throw Error('End missing for: '+from);
 return source.slice(i,j);
}
const code=[
 part('const normalPhone=','\nconst statusTag='),
 part('const template=','\nconst quoteCSV='),
 part('const esc=','\nconst fmtDate='),
 part('function parseCSV(text)','\nfunction parseVCF(raw)'),
 part('function parseVCF(raw)','\nasync function readImportFile(file)'),
 part('function analyzeImportRows(rows,owner)','\nfunction importModal()')
].join('\n');
const helpers=vm.runInNewContext(code+'\n({normalPhone,template,esc,parseCSV,parseVCF,analyzeImportRows})');
const {normalPhone,template,esc,parseCSV,parseVCF,analyzeImportRows}=helpers;

test('Brazilian and international WhatsApp numbers normalize without duplicated country code',()=>{
 assert.equal(normalPhone('(62) 99999-1234'),'5562999991234');
 assert.equal(normalPhone('+55 62 99999-1234'),'5562999991234');
 assert.equal(normalPhone('0055 62 99999 1234'),'5562999991234');
 assert.equal(normalPhone('+1 (212) 555-0000'),'12125550000');
 assert.equal(normalPhone('x'),null);
});
test('invalid phones rejected',()=>{
 assert.equal(normalPhone('abc'),null);
 assert.equal(normalPhone('123'),null);
 assert.equal(normalPhone('999999999999999999999'),null);
});
test('CSV handles semicolon, accented columns and quoted newlines',()=>{
 const csv='Nome;Empresa;Telefone;Cidade;Estado;Consentimento;Fonte do consentimento;Mensagem Enviada;Observações\r\n"Ana; Silva";Loja A;62999991234;Goiânia;GO;sim;Cadastro do site;sim;"Linha 1\nLinha 2"';
 const [x]=parseCSV(csv);
 assert.equal(x.name,'Ana; Silva');assert.equal(x.city,'Goiânia');assert.equal(x.phone,'62999991234');
 assert.equal(x.source,'Cadastro do site');assert.equal(x.sent,'sim');assert.equal(x.notes,'Linha 1\nLinha 2');
});
test('CSV handles comma separated data with escaped quotes',()=>{
 const [x]=parseCSV('nome,empresa,telefone\nMarcos,"Loja ""Central"", Setor 2",63999991111');
 assert.equal(x.business,'Loja "Central", Setor 2');
 assert.equal(x.name,'Marcos');
});
test('VCF imports contact fields and folded names',()=>{
 const v='BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Maria de\r\n Souza\r\nTEL;TYPE=CELL:+55 62 99999-1234\r\nORG:Loja Central\r\nADR:;;Rua A;Goiânia;GO;;Brasil\r\nEND:VCARD';
 const x=parseVCF(v)[0];assert.equal(x.name,'Maria deSouza');assert.equal(x.phone,'+55 62 99999-1234');assert.equal(x.business,'Loja Central');assert.equal(x.state,'GO');
});
test('duplicate imports preserve documented consent and old-send markers',()=>{
 const rows=[
 {name:'Ana',phone:'62999991234',consent:'sim',source:'Formulário'},
 {name:'Ana L.',phone:'(62) 99999-1234',consent:'não',sent:'sim'},
 {name:'Inválido',phone:'x'}
 ];
 const a=analyzeImportRows(rows,'test-owner');
 assert.equal(a.contacts.length,1);assert.equal(a.duplicates,1);assert.equal(a.invalid,1);
 assert.equal(a.contacts[0].consent,true);assert.equal(a.contacts[0].consent_source,'Formulário');
 assert.equal(a.legacy.size,1);
});
test('consent is never assumed from public phone numbers',()=>{
 const a=analyzeImportRows([{name:'Loja',phone:'62999991234',consent:'sim',source:''}],'owner');
 assert.equal(a.contacts[0].consent,false);
});
test('campaign template fills contact details and HTML escapes user-provided text',()=>{
 assert.equal(template({message:'Olá {nome}, loja {loja} em {cidade}'},{name:'Ana',business:'Central',city:'Goiânia'}),'Olá Ana, loja Central em Goiânia');
 assert.equal(esc('<script>'),'&lt;script&gt;');
});
test('manual confirmation uses atomic database RPC instead of direct insert',()=>{
 const section=part('async function markSent(id)','\nfunction parseCSV(text)');
 assert.match(section,/sb\.rpc\('reach_confirm_send'/);
 assert.doesNotMatch(section,/\.from\('reach_events'\)\.insert/);
});
test('file imports use database-side idempotency',()=>{
 const section=part('function importModal()','\nfunction downloadTemplate()');
 assert.match(section,/reach_mark_imported_sent/);
 assert.match(section,/id="import-preview"/);
});
