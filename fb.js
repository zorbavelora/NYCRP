/* Firebase bridge: gives the page the same claude.use(...) API it has on claude.ai,
   backed by Firebase Auth (Google sign-in) and Firestore. Loaded before the page script. */
(function(){
  const V='10.12.0',BASE=`https://www.gstatic.com/firebasejs/${V}/`;
  const ROLES={viewer:'Görüntüleyici',contributor:'Katkıda bulunan',editor:'Düzenleyici'};
  let ctx=null,booting=null;

  /* ---------- Gate screens (sign-in / no access) ---------- */
  function gate(html){
    let g=document.getElementById('fb-gate');
    if(!g){g=document.createElement('div');g.id='fb-gate';document.body.appendChild(g);}
    g.style.cssText='position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 20%,rgba(109,20,33,.35),transparent 60%),#0c0708;color:#ece2d6;font-family:"Cormorant Garamond",Georgia,serif;text-align:center';
    g.innerHTML=`<div style="max-width:440px;display:grid;gap:16px;justify-items:center">
      <div style="font-family:Cinzel,serif;font-size:64px;letter-spacing:.14em;line-height:1">NYC</div>
      <div style="height:1px;width:180px;background:linear-gradient(90deg,transparent,#8d744a,transparent)"></div>${html}</div>`;
    return g;
  }
  const btn='font-family:Cinzel,serif;letter-spacing:.12em;font-size:13px;text-transform:uppercase;padding:12px 22px;border:1px solid #8a5a3e;border-radius:4px;background:linear-gradient(180deg,#8e2333,#6d1421);color:#f4e9dc;cursor:pointer';
  function signInGate(auth,au){
    return new Promise(res=>{
      const g=gate(`<p style="font-size:19px;margin:0">Arşive girmek için Google hesabınla giriş yap.</p>
        <button id="fb-in" style="${btn}">Google ile giriş yap</button><p id="fb-msg" style="margin:0;color:#cf6a7c;min-height:1.4em"></p>`);
      g.querySelector('#fb-in').onclick=async()=>{
        const p=new auth.GoogleAuthProvider();p.setCustomParameters({prompt:'select_account'});
        try{const r=await auth.signInWithPopup(au,p);g.remove();res(r.user);}
        catch(e){
          if(e&&(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment'))auth.signInWithRedirect(au,p);
          else g.querySelector('#fb-msg').textContent=e&&e.code==='auth/unauthorized-domain'?'Bu site adresi Firebase’de yetkili alan olarak eklenmemiş.':'Giriş tamamlanamadı. Yeniden dene.';
        }
      };
    });
  }
  function noAccessGate(email,auth,au){
    const g=gate(`<p style="font-size:19px;margin:0">Bu arşive erişimin yok.</p>
      <p style="margin:0;color:#b4a49c">Yöneticiden <b style="color:#ece2d6">${String(email).replace(/[<>&"]/g,'')}</b> adresini erişim listesine eklemesini iste.</p>
      <button id="fb-out" style="${btn};background:transparent">Başka hesapla gir</button>`);
    g.querySelector('#fb-out').onclick=async()=>{await auth.signOut(au);location.reload();};
  }

  /* ---------- Boot ---------- */
  function boot(){
    if(booting)return booting;
    booting=(async()=>{
      const cfg=window.FIREBASE_CONFIG;
      if(!cfg||!cfg.apiKey){gate('<p style="font-size:19px;margin:0">Firebase ayarı eksik.</p><p style="margin:0;color:#b4a49c">index.html içindeki FIREBASE_CONFIG doldurulmalı.</p>');return null;}
      const [app,auth,fs]=await Promise.all(['firebase-app','firebase-auth','firebase-firestore'].map(m=>import(BASE+m+'.js')));
      const A=app.initializeApp(cfg),au=auth.getAuth(A),db=fs.getFirestore(A);
      try{await auth.getRedirectResult(au);}catch(_){}
      let user=await new Promise(r=>{const un=auth.onAuthStateChanged(au,x=>{un();r(x);});});
      if(!user)user=await signInGate(auth,au);
      const email=String(user.email||'').toLowerCase();
      let role=null;
      try{const a=await fs.getDoc(fs.doc(db,'access',email));if(a.exists())role=a.data().role||'viewer';}catch(_){}
      if(!role){
        // No access entry: the owner (named in the security rules) can still read; everyone else is refused.
        try{await fs.getDoc(fs.doc(db,'meta','settings'));role='owner';}catch(_){role=null;}
      }
      if(!role){noAccessGate(email,auth,au);return null;}
      const C={app,auth,fs,A,au,db,user,email,role,uid:user.uid};
      const canWrite=role!=='viewer';
      if(canWrite){try{await fs.setDoc(fs.doc(db,'members',user.uid),{accountName:user.displayName||'',accountPhoto:user.photoURL||'',email},{merge:true});}catch(_){}}
      ctx=C;return C;
    })();
    return booting;
  }

  /* ---------- db ---------- */
  const mapErr=e=>{const c=e&&e.code||'';return {code:c==='permission-denied'?'invalid_argument':c==='resource-exhausted'?'resource_exhausted':c==='invalid-argument'?'invalid_argument':'unavailable',message:String(e&&e.message||e)};};
  function makeDb(C){
    const {fs,db}=C;
    const snapD=s=>({id:s.id,exists:s.exists(),data:()=>s.exists()?s.data():undefined,metadata:{fromCache:s.metadata.fromCache,hasPendingWrites:s.metadata.hasPendingWrites}});
    const snapQ=s=>({docs:s.docs.map(snapD),size:s.size,empty:s.empty,docChanges:()=>[],metadata:{fromCache:s.metadata.fromCache,hasPendingWrites:s.metadata.hasPendingWrites}});
    const wrap=p=>p.catch(e=>{throw mapErr(e);});
    function docRef(path){
      const r=fs.doc(db,path);
      return {id:r.id,path:r.path,
        get:()=>wrap(fs.getDoc(r)).then(snapD),
        set:d=>wrap(fs.setDoc(r,d)),update:d=>wrap(fs.updateDoc(r,d)),delete:()=>wrap(fs.deleteDoc(r)),
        onSnapshot:(next,err)=>fs.onSnapshot(r,s=>next(snapD(s)),e=>err&&err(mapErr(e))),
        collection:p=>query(r.path+'/'+p,[])};
    }
    function query(path,cons){
      const q=()=>fs.query(fs.collection(db,path),...cons);
      return {path,
        doc:id=>docRef(id?path+'/'+id:fs.doc(fs.collection(db,path)).path),
        where:(f,op,v)=>query(path,[...cons,fs.where(f,op,v)]),
        orderBy:(f,dir)=>query(path,[...cons,fs.orderBy(f,dir||'asc')]),
        limit:n=>query(path,[...cons,fs.limit(n)]),
        get:()=>wrap(fs.getDocs(q())).then(snapQ),
        add:async d=>{const r=docRef(fs.doc(fs.collection(db,path)).path);await r.set(d);return r;},
        onSnapshot:(next,err)=>fs.onSnapshot(q(),s=>next(snapQ(s)),e=>err&&err(mapErr(e)))};
    }
    return {doc:docRef,collection:p=>query(p,[])};
  }

  /* ---------- user ---------- */
  function makeUser(C){
    const {fs,db,user,role}=C,admin=role==='owner'||role==='editor';
    const cache={};
    const initialsSvg=n=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2a171b"/><text x="32" y="40" text-anchor="middle" font-family="Georgia" font-size="24" fill="#c9a66b">${String(n||'?').trim().slice(0,1).toUpperCase().replace(/[<&>]/g,'')}</text></svg>`);
    const me={id:user.uid,name:user.displayName||'',avatarUrl:user.photoURL||initialsSvg(user.displayName),color:'#8e2333',email:C.email,isOwner:role==='owner',canEdit:admin};
    return {
      isOwner:async()=>role==='owner',canEdit:async()=>admin,
      can:async n=>n==='data.write'?role!=='viewer':n==='assets.write'?admin:null,
      id:async()=>user.uid,me:async()=>me,name:async()=>me.name,email:async()=>me.email,avatarUrl:async()=>me.avatarUrl,
      profiles:async ids=>{
        const out={};
        await Promise.all([].concat(ids).map(async id=>{
          if(!cache[id]){cache[id]=(async()=>{try{const s=await fs.getDoc(fs.doc(db,'members',id));const d=s.exists()?s.data():{};return {name:d.accountName||'',avatarUrl:d.accountPhoto||''};}catch(_){return {name:'',avatarUrl:''};}})();}
          const p=await cache[id];out[id]={id,name:p.name,avatarUrl:p.avatarUrl||initialsSvg(p.name),color:'#8e2333',email:null,isMe:id===user.uid,guest:false};
        }));
        return out;
      },
      search:async()=>[]
    };
  }

  /* ---------- assets (stored in Firestore, images shrunk in the browser) ---------- */
  const MAX=880*1024,blobs={},pending={};
  const toDataURL=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});
  async function shrink(file){
    const url=URL.createObjectURL(file);
    try{
      const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url;});
      let dim=1600,q=.86,out='';
      for(let n=0;n<8;n++){
        const s=Math.min(1,dim/Math.max(img.naturalWidth,img.naturalHeight)),c=document.createElement('canvas');
        c.width=Math.max(1,Math.round(img.naturalWidth*s));c.height=Math.max(1,Math.round(img.naturalHeight*s));
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        out=c.toDataURL('image/webp',q);if(!out.startsWith('data:image/webp'))out=c.toDataURL('image/jpeg',q);
        if(out.length<=MAX)return out;
        q=Math.max(.5,q-.1);dim=Math.round(dim*.8);
      }
      return out.length<=MAX?out:null;
    }finally{URL.revokeObjectURL(url);}
  }
  const dataToObjectURL=d=>{const [h,b]=d.split(',');const mime=(h.match(/data:([^;]+)/)||[])[1]||'application/octet-stream';const bin=atob(b),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return URL.createObjectURL(new Blob([u],{type:mime}));};
  function makeAssets(C){
    const {fs,db}=C;
    return {
      upload:async(file,opts)=>{
        const type=(opts&&opts.type)||file.type||'';
        const data=/^image\/(png|jpeg|webp)$/.test(type)?await shrink(file):await toDataURL(file);
        if(!data||data.length>MAX)throw {code:'too_large',message:'too large'};
        const ref=fs.doc(fs.collection(db,'blobs'));
        try{await fs.setDoc(ref,{data,type,name:file.name||'',by:C.uid,at:new Date().toISOString()});}catch(e){throw mapErr(e);}
        const id='fb_'+ref.id;blobs[id]=dataToObjectURL(data);
        return {id,url:blobs[id],sizeBytes:data.length,contentType:type};
      },
      list:async()=>({assets:[],usage:{files:0,bytes:0,maxFiles:0,maxBytes:0}}),
      delete:async id=>{try{await fs.deleteDoc(fs.doc(db,'blobs',String(id).replace(/^fb_/,'')));return {deleted:true};}catch(e){throw mapErr(e);}}
    };
  }
  const PIXEL='data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  let redraw=null;
  window.__blobURL=id=>{
    if(blobs[id])return blobs[id];
    if(!/^fb_/.test(id))return '/_blob/'+id;
    if(!pending[id]&&ctx){
      pending[id]=ctx.fs.getDoc(ctx.fs.doc(ctx.db,'blobs',id.slice(3))).then(s=>{
        if(s.exists()&&s.data().data){blobs[id]=dataToObjectURL(s.data().data);clearTimeout(redraw);redraw=setTimeout(()=>window.__rerender&&window.__rerender(),60);}
      }).catch(()=>{});
    }
    return PIXEL;
  };

  /* ---------- downloads ---------- */
  const downloads={save:async({filename,data})=>{
    const b=data instanceof Blob?data:new Blob([data]);const u=URL.createObjectURL(b),a=document.createElement('a');
    a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);return {status:'saved'};}};

  /* ---------- room (who is online, from a heartbeat in Firestore) ---------- */
  function makeRoom(C){
    const {fs,db,uid}=C,ref=fs.doc(db,'presence',uid);let docs=[],fns=[];
    const beat=()=>fs.setDoc(ref,{at:new Date().toISOString()}).catch(()=>{});
    beat();setInterval(()=>{if(document.visibilityState==='visible')beat();},90000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')beat();});
    const emit=()=>{const cut=Date.now()-200000;const peers=docs.filter(d=>Date.parse(d.at)>cut).map(d=>Object.freeze({peer:d.id,by:d.id,isMe:d.id===uid,sameTab:d.id===uid,kind:'viewer',guest:false,presence:{},updatedAt:Date.parse(d.at)}));fns.forEach(f=>f({peers,joined:[],left:[],updated:[]}));};
    fs.onSnapshot(fs.collection(db,'presence'),s=>{docs=s.docs.map(d=>({id:d.id,at:d.data().at}));emit();},()=>{});
    setInterval(emit,30000);
    return {onPeers:(f)=>{fns.push(f);setTimeout(emit,0);return()=>{fns=fns.filter(x=>x!==f);};},presence:async()=>{},peers:()=>[],connected:()=>true,onConnection:f=>{setTimeout(()=>f(true),0);return()=>{};},emit:async()=>{},on:()=>()=>{}};
  }

  /* ---------- public surface ---------- */
  const made={};
  window.claude={
    isFirebase:true,roles:ROLES,
    use:async name=>{
      const C=await boot();if(!C)return null;
      if(made[name])return made[name];
      const f={db:makeDb,user:makeUser,assets:c=>c.role==='viewer'?null:makeAssets(c),downloads:()=>downloads,room:makeRoom}[name];
      return f?(made[name]=f(C)):null;
    },
    signOut:async()=>{const C=await boot();if(C){try{await C.fs.deleteDoc(C.fs.doc(C.db,'presence',C.uid));}catch(_){}await C.auth.signOut(C.au);}location.reload();}
  };
})();
