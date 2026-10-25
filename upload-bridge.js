/* Independent iPhone file-input bridge. */
(() => {
 "use strict";
 const picker=document.getElementById("easy-files");
 const feedback=document.getElementById("easy-upload-feedback");
 if(!picker||!feedback)return;
 let pending=null;
 const show=(message)=>{feedback.textContent=message;};
 show("画像の選択待ち（添付機能の準備中）");
 const deliver=async()=>{
   if(!pending)return;
   if(typeof window.stampImportFiles!=="function"){
     show("画像は選択されましたが、加工プログラムが起動していません。画面を更新してください。");return;
   }
   const files=pending;pending=null;
   try{await window.stampImportFiles(files);}
   catch(error){show("読み込みエラー："+(error?.message||String(error)));}
 };
 picker.addEventListener("change",()=>{
   pending=Array.from(picker.files||[]);
   if(!pending.length){show("画像が選択されませんでした。");return;}
   show("画像を選択しました："+pending.map(f=>f.name).join("、"));
   void deliver();
 });
 window.addEventListener("stamp-import-ready",()=>{
   if(pending)void deliver();
   else show("画像を選択してください（添付機能は起動済み）");
 });
 window.addEventListener("error",(event)=>{
   if(typeof window.stampImportFiles!=="function")
     show("加工プログラムの起動エラー："+(event.message||"詳細不明"));
 });
})();
/* The normal editor uses a separate input and must also be bound independently. */
(() => {
 const input=document.getElementById("file-input");
 const status=document.getElementById("normal-upload-feedback");
 if(!input||!status)return;
 const show=(s)=>{status.textContent=s;};
 input.addEventListener("change",async()=>{
   const files=Array.from(input.files||[]);
   if(!files.length){show("画像が選択されませんでした");return;}
   show("画像を選択しました："+files.map(f=>f.name).join("、"));
   if(typeof window.stampImportNormalFiles!=="function"){
     show("画像は選択できましたが、加工プログラムが起動していません。");return;
   }
   try{await window.stampImportNormalFiles(files);show("画像の読み込み処理が終了しました。元画像一覧を確認してください。");}
   catch(e){show("読み込みエラー："+(e?.message||String(e)));}
 });
 window.addEventListener("error",(e)=>{
   if(typeof window.stampImportNormalFiles!=="function")
     show("加工プログラムの起動エラー："+(e.message||"詳細不明"));
 });
 window.addEventListener("stamp-import-ready",()=>show("画像選択の準備ができました"));
})();