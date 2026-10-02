const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function setup(){
  const data=new Map();
  const ctx=vm.createContext({crypto:require('node:crypto').webcrypto,localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},console});
  for(const file of ['models.js','template_store.js','signing_flow.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  return vm.runInContext(`({models:Models,store:TemplateStore,flow:SigningFlow,template:Models.createTemplate({name:'原本',pdfBase64:'JVBERi0xLjQK',pages:[{widthPt:595,heightPt:842,fields:[Models.createField({id:'one',x:50,y:50})]}]})})`,ctx);
}
test('二人目の家族の必須同意も内部フローで確認し、未確認なら確定を拒否する',()=>{
  const {models,flow,template}=setup();template.signingMode='all';
  template.pages[0].fields.push(models.createField({id:'two',signOrder:2,x:50,y:180}),models.createField({id:'consent',type:'declaration_checkbox',assignedRole:'family',linkedFieldId:'two',label:'家族情報の利用に同意',x:50,y:300}));
  flow.startSession(template,'本人',null,{primaryRole:'recipient'});
  flow.submitCurrentSigner({role:'recipient',typedName:'本人',signatureImageDataUrl:'data:image/png;base64,x'});
  const input={role:'additional',typedName:'娘',signatureImageDataUrl:'data:image/png;base64,x'};
  assert.throws(()=>flow.submitCurrentSigner(input),/確認/);
  flow.submitCurrentSigner({...input,confirmedDeclarationIds:['consent'],confirmedDeclarations:['家族情報の利用に同意']});
  assert.equal(flow.isQueueComplete(),true);
});
test('一人目を訂正すると、その人以降の署名を取り直し既存署名の履歴を残す',()=>{
  const {models,flow,template}=setup();template.signingMode='all';
  template.pages[0].fields.push(models.createField({id:'two',signOrder:2,x:50,y:180}));
  flow.startSession(template,'本人',null,{primaryRole:'recipient'});
  flow.submitCurrentSigner({role:'recipient',typedName:'本人',signatureImageDataUrl:'data:image/png;base64,x'});
  flow.submitCurrentSigner({role:'additional',typedName:'娘',signatureImageDataUrl:'data:image/png;base64,x'});
  flow.redoSignerFrom('one');
  assert.equal(flow.getSession().signers.length,0);
  assert.equal(flow.getCurrentField().id,'one');
  assert.equal(flow.getSession().eventLog.filter(e=>e.type==='signer_redo').length,2);
});
