const {chromium}=require('playwright');
const ROUTES=["#/","#/markets","#/signals","#/screen","#/funds","#/ipo","#/news","#/watch","#/methodology"];
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:900}});
for(const r of ROUTES){
 await p.goto('https://signal.askakshay.com/'+r,{waitUntil:'domcontentloaded'});await p.waitForTimeout(7000);
 const t=await p.evaluate(()=>[...document.querySelectorAll('main .hint, main .sec-note, main .tr-n, main .note, main .pl-key, main .sec-lead, main .empty')]
   .map(e=>e.innerText.replace(/\s+/g,' ').trim()).filter(x=>x.length>40));
 console.log('\n===== '+r+'  ('+t.length+' prose blocks)');
 t.forEach(x=>console.log('  • '+(x.length>210?x.slice(0,210)+'…':x)));
}
await b.close();})()
