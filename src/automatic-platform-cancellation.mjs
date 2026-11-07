export async function initializeAutomaticPlatformCancellation(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS automatic_platform_cancellation(
 day TEXT PRIMARY KEY,report_id TEXT,cursor TEXT NOT NULL DEFAULT '',
 phase TEXT NOT NULL DEFAULT 'checking',updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

export function cancellationSchedule(now=new Date(),timeZone='Europe/Paris'){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 return {day:`${parts.year}-${parts.month}-${parts.day}`,due:Number(parts.hour)*60+Number(parts.minute)>=450};
}

// One persisted step per tick; restarting resumes the report before starting a new day.
export function automaticPlatformCancellation(db,reports,{now=()=>new Date(),timeZone='Europe/Paris',shouldStop=()=>false}={}){
 const user={email:'automatic-platform-cancellation@system',role:'operator'};
 let running=false;
 return {async run(){
  if(running||shouldStop())return;
  running=true;
  try{
   const schedule=cancellationSchedule(now(),timeZone);
   let job=(await db.query("SELECT * FROM automatic_platform_cancellation WHERE phase<>'complete' ORDER BY day LIMIT 1")).rows[0];
   if(!job&&schedule.due){
    await db.query('INSERT INTO automatic_platform_cancellation(day) VALUES($1) ON CONFLICT DO NOTHING',[schedule.day]);
    job=(await db.query("SELECT * FROM automatic_platform_cancellation WHERE day=$1 AND phase<>'complete'",[schedule.day])).rows[0];
   }
   if(!job)return;
   if(job.phase==='checking'){
    // A crash can occur after the report is completed but before the cursor is saved.
    const complete=job.report_id&&(await reports.read(job.report_id)).scan_complete;
    const response=complete?{done:true,reportId:job.report_id}:await reports.next({reportId:job.report_id||undefined,cursor:job.cursor||undefined,channels:['temu','shopify']},user);
    await db.query('UPDATE automatic_platform_cancellation SET report_id=$2,cursor=$3,phase=$4,updated_at=now() WHERE day=$1',[job.day,response.reportId,response.done?'':response.cursor,response.done?'applying':'checking']);
    return;
   }
   const row=(await db.query(`SELECT order_id FROM platform_cancellation_report_rows
    WHERE report_id=$1 AND checked->>'platformCancelled'='true' AND applied IS NULL ORDER BY order_id LIMIT 1`,[job.report_id])).rows[0];
   if(row){await reports.apply({reportId:job.report_id,id:row.order_id},user);return;}
   await reports.finish({reportId:job.report_id,issues:[]});
   await db.query("UPDATE platform_cancellation_reports SET status='complete',updated_at=now() WHERE id=$1",[job.report_id]);
   await db.query("UPDATE automatic_platform_cancellation SET phase='complete',updated_at=now() WHERE day=$1",[job.day]);
  }finally{running=false;}
 }};
}
