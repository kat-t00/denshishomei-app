const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function setup(){const data=new Map();const ctx=vm.createContext({crypto:require('node:crypto').webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,atob,btoa,console,localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)}});
 for(const file of ['models.js','signing_flow.js','operator_settings.js','draft_vault.js']) {const p=path.join(__dirname,'..',file);if(fs.existsSync(p))vm.runInContext(fs.readFileSync(p,'utf8'),ctx);}
 return {ctx,api:vm.runInContext(`({models:Models,flow:SigningFlow,settings:typeof OperatorSettings==='undefined'?null:OperatorSettings,vault:typeof DraftVault==='undefined'?null:DraftVault})`,ctx)};}
test('代理署名後も同じ家族の住所・建物名を引継ぎ、本人住所と混同しない',()=>{
 const {api:{models,flow}}=setup();const template=models.createTemplate({signingMode:'all',pages:[{widthPt:595,heightPt:842,fields:[models.createField({id:'one',x:50,y:50}),models.createField({id:'two',x:50,y:250,signOrder:2})]}]});
 flow.startSession(template,'本人',null,{primaryRole:'family',primaryCapacity:'representative',recipientAddress:'本人住所',recipientBuilding:'本人マンション101'});
 flow.submitCurrentSigner({role:'family',typedName:'家族',address:'家族住所',building:'家族マンション202',relationship:'長女',signingCapacity:'representative',declarationChecked:true,authorityBasis:'委任状を確認',signatureImageDataUrl:'data:image/png;base64,x'});
 const details=flow.getReusableScribeDetails();assert.ok(details);assert.equal(details.address,'家族住所');assert.equal(details.building,'家族マンション202');
 assert.equal(flow.getSession().recipientBuilding,'本人マンション101');
 flow.submitCurrentSigner({...details,role:'additional',signatureImageDataUrl:'data:image/png;base64,y'});
 assert.equal(flow.getSession().signers[1].building,'家族マンション202');
});
test('事業所登録は職員候補を整えて保存し、利用者の情報を保存しない',()=>{
 const {api:{settings}}=setup();assert.ok(settings);
 settings.save({providerName:' ケア事業所 ',staffNames:[' 担当A ','担当A','担当B'],recipientName:'秘密'});
 const saved=settings.load();assert.equal(saved.providerName,'ケア事業所');assert.deepEqual(Array.from(saved.staffNames),['担当A','担当B']);assert.equal(saved.recipientName,undefined);
});
test('途中保存は暗号化され、誤パスワード・改変を拒否し、正しい鍵で復元する',async()=>{
 const {api:{vault}}=setup();assert.ok(vault);const source={format:'keiyaku-draft-state',version:1,person:'秘密の氏名',signers:[{signature:'署名'}]};
 const text=await vault.encrypt(source,'秘密password123');assert.ok(!text.includes('秘密の氏名'));assert.ok(!text.includes('秘密password123'));
 assert.equal((await vault.decrypt(text,'秘密password123')).person,'秘密の氏名');
 await assert.rejects(()=>vault.decrypt(text,'間違いpassword123'),/パスワード|破損/);
 const file=JSON.parse(text);file.ciphertext=file.ciphertext.slice(0,-4)+'AAAA';await assert.rejects(()=>vault.decrypt(JSON.stringify(file),'秘密password123'));
 await assert.rejects(()=>vault.encrypt(source,'short'),/12/);
});
test('途中の工程と確定した署名を復元し、未対応の工程データを拒否する',()=>{
 const {api:{models,flow}}=setup();const template=models.createTemplate({pdfBase64:'JVBERi0=',signingMode:'all',pages:[{widthPt:595,heightPt:842,fields:[models.createField({id:'one',x:50,y:50}),models.createField({id:'two',x:50,y:250,signOrder:2})]}]});
 flow.startSession(template,'本人',null,{primaryRole:'recipient'});flow.submitCurrentSigner({role:'recipient',typedName:'本人',signatureImageDataUrl:'data:image/png;base64,x'});
 const state=flow.exportState();flow.restoreState(state);assert.equal(flow.getCurrentField().id,'two');assert.equal(flow.getSession().signers.length,1);
 assert.throws(()=>flow.restoreState({...state,queueIndex:200}),/途中/);
});
