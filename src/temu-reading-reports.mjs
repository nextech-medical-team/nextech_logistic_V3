export function attachReportTracking(snapshot,report){
 const byReference=new Map();for(const x of report.matches||[]){if(x.ambiguous)continue;for(const ref of x.orders||[]){const list=byReference.get(ref)||[];list.push(x);byReference.set(ref,list);}}
 const checked=new Map((report.results||[]).map(x=>[x.carrier+':'+x.tracking,x]));
 return {...snapshot,rows:(snapshot.rows||[]).map(r=>({...r,reportTracking:[...new Map((byReference.get(r.reference)||[]).map(m=>[m.carrier+':'+m.tracking,{carrier:m.carrier,tracking:m.tracking,source:m.source,sourceRow:m.sourceRow,reportStatus:m.reportStatus,...checked.get(m.carrier+':'+m.tracking)}])).values()]}))};
}
