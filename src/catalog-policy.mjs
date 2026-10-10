export function catalogOperation(account,query,verified=false){
 const mutation=query.trim().startsWith('mutation ');
 if(!['source','target'].includes(account)||(!mutation&&!query.trim().startsWith('query ')))throw new Error('Opération interdite');
 if(mutation)throw new Error('Écritures ERPLAIN suspendues jusqu’au GO');
 return mutation;
}
export function assertCatalogIdentity(account,id){
 if(!['source','target'].includes(account)||String(id)!==(account==='source'?'100174':'100174'))throw new Error('Société '+account+' inattendue');
}
