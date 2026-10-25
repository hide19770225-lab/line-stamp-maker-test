(() => {
 "use strict";
 const el=document.getElementById("boot-diagnostic");
 if(!el)return;
 const show=(msg,bg="#fff0c2")=>{el.textContent=msg;el.style.background=bg;};
 window.addEventListener("error",(event)=>{
   show("診断：JavaScriptエラー："+(event.message||"読み込み失敗"),"#ffd7d7");
 });
 window.addEventListener("unhandledrejection",(event)=>{
   show("診断：処理エラー："+(event.reason?.message||String(event.reason)),"#ffd7d7");
 });
 function bind(id,label){
   const input=document.getElementById(id);
   if(!input)return;
   input.addEventListener("change",()=>{
     show("診断："+label+"の画像選択を検知（"+(input.files?.length||0)+"枚）","#dcfce7");
   });
 }
 bind("file-input","通常制作");
 bind("easy-files","一括制作");
 show("診断：JavaScript実行OK。画像を選択できます。");
 window.addEventListener("load",()=>{
   if(typeof window.stampImportNormalFiles!=="function")
     show("診断：加工プログラムが起動していません。JavaScriptエラーを調査中。","#ffd7d7");
   else show("診断：加工プログラム起動済み。画像を選択してください。","#dcfce7");
 });
})();