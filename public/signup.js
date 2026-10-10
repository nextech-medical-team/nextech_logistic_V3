(()=>{
 const form=document.getElementById('login-form'),toggle=document.getElementById('signup-toggle'),password=document.getElementById('password'),title=document.getElementById('login-title'),help=document.getElementById('login-help'),error=document.getElementById('login-error'),success=document.getElementById('signup-success');
 let registering=false,busy=false;
 toggle.addEventListener('click',()=>{
  registering=!registering;error.textContent='';success.hidden=true;
  title.textContent=registering?'Créer votre compte.':'Votre espace logistique.';
  help.textContent=registering?'Inscrivez-vous avec votre email et un mot de passe d’au moins 12 caractères.':'Connectez-vous à NEXTECH LOGISTIC V3.';
  password.autocomplete=registering?'new-password':'current-password';
  form.querySelector('button').textContent=registering?'Créer mon compte':'Continuer →';
  toggle.textContent=registering?'J’ai déjà un compte — me connecter':'Créer un compte';
 });
 form.addEventListener('submit',async e=>{
  if(!registering)return;e.preventDefault();e.stopImmediatePropagation();if(busy)return;
  busy=true;const submit=form.querySelector('button');submit.disabled=true;toggle.disabled=true;error.textContent='';
  try{
   const response=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:password.value})});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Inscription impossible.');
   toggle.disabled=false;toggle.click();password.value='';success.textContent='Compte créé. Vous pouvez maintenant vous connecter.';success.hidden=false;
  }catch(err){error.textContent=err.message;}
  finally{busy=false;submit.disabled=false;toggle.disabled=false;}
 },true);
})();
