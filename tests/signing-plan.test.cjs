const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function setup(mode,count=2){
  const context=vm.createContext({crypto:require('node:crypto').webcrypto});
  for(const file of ['models.js','signing_flow.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  return vm.runInContext(`({Models,SigningFlow,template:Models.createTemplate({signingMode:${JSON.stringify(mode)},pages:[{widthPt:595,heightPt:842,fields:Array.from({length:${count}},(_,i)=>Models.createField({id:'sig'+i,signOrder:i+1,required:false,x:40,y:40+i*60}))}]})})`,context);
}
const input={role:'recipient',typedName:'本人',signatureImageDataUrl:'data:image/png;base64,test'};
test('本人だけで足りる場合は追加署名を予定から外し、理由を残す',()=>{
  const {SigningFlow:flow,template}=setup('optional');
  flow.startSession(template,'利用者',null,{primaryRole:'recipient',includeAdditional:false});
  assert.equal(flow.getProgress().total,1);
  flow.submitCurrentSigner(input);
  assert.equal(flow.isQueueComplete(),true);
  assert.match(JSON.stringify(flow.getSession().eventLog),/additional_not_required/);
});
test('代筆時は家族本人の署名を必須にする設定を守り、本人自署と旧設定は変えない',()=>{
  const {SigningFlow:flow,template}=setup('optional');
  assert.equal(template.requireAdditionalForScribe,true);
  assert.throws(()=>flow.startSession(template,'利用者',null,{primaryRole:'family',primaryCapacity:'scribe',includeAdditional:false}),/家族本人の署名/);
  flow.startSession(template,'利用者',null,{primaryRole:'family',primaryCapacity:'scribe',includeAdditional:true});
  assert.equal(flow.getProgress().total,2);
  flow.startSession(template,'利用者',null,{primaryRole:'recipient',includeAdditional:false});
  assert.equal(flow.getProgress().total,1);
  template.requireAdditionalForScribe=false;
  flow.startSession(template,'利用者',null,{primaryRole:'family',primaryCapacity:'scribe',includeAdditional:false});
  assert.equal(flow.getProgress().total,1);
});
test('代筆時の必須設定では2欄目を別の人の氏名で確定できない',()=>{
  const {SigningFlow:flow,template}=setup('optional');
  flow.startSession(template,'利用者',null,{primaryRole:'family',primaryCapacity:'scribe',includeAdditional:true});
  flow.submitCurrentSigner({role:'family',signingCapacity:'scribe',typedName:'娘 花子',recipientConsentConfirmed:true,signatureImageDataUrl:input.signatureImageDataUrl});
  assert.throws(()=>flow.submitCurrentSigner({role:'additional',typedName:'息子 次郎',signatureImageDataUrl:input.signatureImageDataUrl}),/先ほど代筆したご家族本人/);
  flow.submitCurrentSigner({role:'additional',typedName:'娘 花子',signatureImageDataUrl:input.signatureImageDataUrl});
  assert.equal(flow.isQueueComplete(),true);
});
test('追加署名を選択した場合と全員必須の場合は省略できない',()=>{
  for(const mode of ['optional','all']){
    const {SigningFlow:flow,template}=setup(mode);
    flow.startSession(template,'利用者',null,{primaryRole:'recipient',includeAdditional:true});
    assert.throws(()=>flow.skipCurrentField());
    flow.submitCurrentSigner(input);
    assert.equal(flow.isQueueComplete(),false);
    assert.throws(()=>flow.completeSession());
    assert.throws(()=>flow.skipCurrentField());
    flow.submitCurrentSigner({...input,role:'additional',typedName:'家族'});
    flow.completeSession();assert.equal(flow.getSession().status,'completed');
  }
});
test('代理署名でも利用者名は変わらず、署名前に選んだ立場を守る',()=>{
  const {SigningFlow:flow,template}=setup('single',1);
  flow.startSession(template,'利用者本人',null,{primaryRole:'family',includeAdditional:false});
  assert.throws(()=>flow.submitCurrentSigner(input));
  flow.submitCurrentSigner({...input,role:'family',signingCapacity:'representative',typedName:'代理人',declarationChecked:true,authorityBasis:'代理権を確認'});
  assert.equal(flow.getSession().recipientName,'利用者本人');
  assert.equal(flow.getSession().signers[0].typedName,'代理人');
});
test('従来テンプレートの任意署名は移行を強制しない',()=>{
  const {SigningFlow:flow,template}=setup('legacy');
  flow.startSession(template,'本人');flow.skipCurrentField();
  assert.equal(flow.getCurrentField().id,'sig1');
});
